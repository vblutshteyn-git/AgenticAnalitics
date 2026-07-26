/**
 * HTTP layer: REST for the web UI, SSE for the live agent run, and the MCP
 * streamable-HTTP endpoint for remote agents.
 *
 * Built on node:http with no framework. The routing surface is small enough
 * that a dependency would add more to read than it removes.
 *
 * The web UI and the MCP server share one {@link DatasetStore}: a dataset
 * uploaded by an agent over MCP appears in the browser immediately, and a
 * dataset uploaded in the browser is queryable over MCP. That shared store is
 * the whole point of running both surfaces in one process.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createLlmClient, planQuery } from '../agent/llm.js';
import { runAgent } from '../agent/orchestrator.js';
import { executeQuery, QueryError } from '../core/query.js';
import type { DatasetStore } from '../core/store.js';
import type { Insight, SemanticQuery } from '../core/types.js';
import { buildMcpServer } from '../mcp/server.js';
import { SAMPLE_DATASETS } from '../tools/samples.js';

export interface ServerOptions {
  store: DatasetStore;
  port: number;
  host: string;
  /** Directory containing the static frontend. */
  webRoot: string;
}

/** Upload cap; the store enforces its own limit too. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createHttpServer(options: ServerOptions): Server {
  const { store, webRoot } = options;

  return createServer((req, res) => {
    handle(req, res, store, webRoot).catch((err) => {
      console.error('[http] необработанная ошибка:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: DatasetStore,
  webRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The UI is same-origin; CORS is opened only for the MCP endpoint so remote
  // agent clients can reach it.
  if (path === '/mcp') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, mcp-protocol-version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    await handleMcp(req, res, store);
    return;
  }

  if (path.startsWith('/api/')) {
    await handleApi(req, res, url, method, store);
    return;
  }

  await serveStatic(req, res, path, webRoot);
}

// ---------------------------------------------------------------------------
// MCP over streamable HTTP
// ---------------------------------------------------------------------------

/**
 * Stateless mode: a fresh server and transport per request, torn down when the
 * response closes. Datasets live in the shared store rather than in session
 * state, so there is nothing a session would need to remember — and statelessness
 * means a restart never orphans a client.
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse, store: DatasetStore): Promise<void> {
  let body: unknown;
  if (req.method === 'POST') {
    try {
      const raw = await readBody(req);
      body = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      return;
    }
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(store);

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  store: DatasetStore,
): Promise<void> {
  const path = url.pathname;

  try {
    // --- capability probe, so the UI can hide LLM-only affordances ---------
    if (path === '/api/status' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        llmAvailable: createLlmClient() !== null,
        samples: SAMPLE_DATASETS.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
      });
      return;
    }

    // --- datasets ----------------------------------------------------------
    if (path === '/api/datasets' && method === 'GET') {
      sendJson(res, 200, { datasets: store.list() });
      return;
    }

    if (path === '/api/datasets' && method === 'POST') {
      const body = await readJson<{ name?: string; content?: string; format?: string; notes?: string }>(req);
      if (!body.name || !body.content) {
        sendJson(res, 400, { error: 'Требуются поля name и content.' });
        return;
      }
      const { dataset, warnings } = store.ingest(body.content, {
        name: body.name,
        source: 'upload',
        formatHint: body.format === 'auto' ? undefined : body.format,
        notes: body.notes,
      });
      sendJson(res, 201, {
        dataset: publicDataset(dataset),
        warnings,
      });
      return;
    }

    if (path === '/api/samples' && method === 'POST') {
      const body = await readJson<{ id?: string }>(req);
      const sample = SAMPLE_DATASETS.find((s) => s.id === body.id);
      if (!sample) {
        sendJson(res, 404, { error: `Демо-набор «${body.id}» не найден.` });
        return;
      }
      const { dataset, warnings } = store.ingest(sample.generate(), {
        name: sample.name,
        source: 'sample',
        formatHint: 'csv',
        notes: sample.description,
      });
      sendJson(res, 201, { dataset: publicDataset(dataset), warnings });
      return;
    }

    const datasetMatch = path.match(/^\/api\/datasets\/([^/]+)(?:\/(.+))?$/);
    if (datasetMatch) {
      const id = decodeURIComponent(datasetMatch[1]!);
      const sub = datasetMatch[2];

      if (!sub && method === 'GET') {
        sendJson(res, 200, { dataset: publicDataset(store.require(id)) });
        return;
      }
      if (!sub && method === 'DELETE') {
        sendJson(res, 200, { deleted: store.delete(id) });
        return;
      }

      if (sub === 'semantic' && method === 'PATCH') {
        const body = await readJson<Record<string, unknown>>(req);
        const dataset = store.require(id);
        const patch: Record<string, unknown> = {};
        if (typeof body['reviewed'] === 'boolean') patch['reviewed'] = body['reviewed'];
        if (Array.isArray(body['measures'])) patch['measures'] = body['measures'];
        if (typeof body['grainDescription'] === 'string') patch['grainDescription'] = body['grainDescription'];
        const updated = store.updateSemanticModel(dataset.id, patch);
        sendJson(res, 200, { semantic: updated });
        return;
      }

      if (sub === 'insights' && method === 'GET') {
        store.require(id);
        sendJson(res, 200, { insights: store.getInsights(id) });
        return;
      }

      if (sub === 'analyze' && method === 'GET') {
        await streamAnalysis(res, store, id, url.searchParams.get('focus') ?? undefined);
        return;
      }

      if (sub === 'query' && method === 'POST') {
        const dataset = store.require(id);
        const query = await readJson<SemanticQuery>(req);
        const result = executeQuery(dataset, { ...query, datasetId: id });
        sendJson(res, 200, { result });
        return;
      }

      if (sub === 'ask' && method === 'POST') {
        const dataset = store.require(id);
        const body = await readJson<{ question?: string }>(req);
        if (!body.question) {
          sendJson(res, 400, { error: 'Требуется поле question.' });
          return;
        }
        const llm = createLlmClient();
        if (!llm) {
          sendJson(res, 503, {
            error:
              'Вопросы на естественном языке требуют переменной окружения ANTHROPIC_API_KEY. ' +
              'Без неё доступен конструктор запросов и полный автоматический анализ.',
          });
          return;
        }
        const planned = await planQuery(llm, dataset, body.question);
        if ('error' in planned) {
          sendJson(res, 422, { error: planned.error });
          return;
        }
        const result = executeQuery(dataset, planned.query);
        sendJson(res, 200, { result, query: planned.query, reasoning: planned.reasoning });
        return;
      }
    }

    sendJson(res, 404, { error: `Неизвестный маршрут: ${method} ${path}` });
  } catch (err) {
    if (err instanceof QueryError) {
      sendJson(res, 400, { error: err.message, suggestions: err.suggestions });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('не найден') ? 404 : 400;
    sendJson(res, status, { error: message });
  }
}

/**
 * Stream the agent run as Server-Sent Events.
 *
 * The point of streaming is not progress-bar cosmetics: showing which
 * hypotheses were generated and how many were rejected is what makes the
 * conclusions legible. A user who watched 180 tests run and 6 survive
 * understands the 6 differently than one handed a list.
 */
async function streamAnalysis(
  res: ServerResponse,
  store: DatasetStore,
  datasetId: string,
  focus?: string,
): Promise<void> {
  const dataset = store.require(datasetId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const collected: Insight[] = [];
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    for await (const event of runAgent(dataset, { focus, llm: createLlmClient() })) {
      if (aborted) break;
      if (event.insight) collected.push(event.insight);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (!aborted) {
      // The rank phase re-emits confirmed insights; keep one copy of each.
      store.setInsights(datasetId, Array.from(new Map(collected.map((i) => [i.id, i])).values()));
    }
  } catch (err) {
    if (!aborted) {
      res.write(
        `data: ${JSON.stringify({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
          progress: 1,
        })}\n\n`,
      );
    }
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  webRoot: string,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  // Resolve then verify containment: a crafted path must not escape webRoot.
  const target = resolve(join(webRoot, normalize(relative)));
  const rootResolved = resolve(webRoot);
  if (!target.startsWith(rootResolved + '/') && target !== rootResolved) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(target) || !statSync(target).isFile()) {
    // Unknown paths fall back to the app shell; the UI is a single page.
    const shell = join(rootResolved, 'index.html');
    if (existsSync(shell)) {
      const html = await readFile(shell);
      res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Content-Length': html.length });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(404).end('Not found');
    return;
  }

  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(target).size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publicDataset(dataset: {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  rowCount: number;
  columns: string[];
  profiles: unknown;
  semantic: unknown;
  notes?: string;
}) {
  // The row values are deliberately not serialised — the UI works from the
  // profile and the semantic model, and shipping the raw table would be both
  // slow and pointless.
  return {
    id: dataset.id,
    name: dataset.name,
    source: dataset.source,
    createdAt: dataset.createdAt,
    rowCount: dataset.rowCount,
    columns: dataset.columns,
    profiles: dataset.profiles,
    semantic: dataset.semantic,
    notes: dataset.notes,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Тело запроса превышает допустимый размер.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Некорректный JSON в теле запроса.');
  }
}

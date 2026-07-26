/**
 * Entry point: one process serving the web UI, the REST API, and the MCP
 * endpoint over a shared dataset store.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../core/paths.js';
import { DatasetStore } from '../core/store.js';
import { createLlmClient } from '../agent/llm.js';
import { createHttpServer } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));
// The frontend has no build step; it is served from source next to dist/.
const webRoot = resolve(here, '../../src/web');

const port = Number(process.env['PORT'] ?? 4173);
const host = process.env['HOST'] ?? '127.0.0.1';
const dataDir = resolveDataDir();

const store = new DatasetStore(dataDir);
const server = createHttpServer({ store, port, host, webRoot });

server.listen(port, host, () => {
  const existing = store.list().length;
  console.log('');
  console.log('  Agentics Analytics — data to insight');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`  Веб-интерфейс   http://${host}:${port}`);
  console.log(`  MCP (HTTP)      http://${host}:${port}/mcp`);
  console.log(`  MCP (stdio)     node dist/mcp/stdio.js`);
  console.log(`  Данные          ${dataDir}`);
  console.log(`  Наборов         ${existing}`);
  console.log(
    `  Языковая модель ${
      createLlmClient()
        ? 'подключена (нарратив и вопросы на естественном языке)'
        : 'не настроена — анализ работает полностью, без LLM-формулировок'
    }`,
  );
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[server] получен ${signal}, останавливаюсь.`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

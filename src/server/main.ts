/**
 * Entry point: one process serving the web UI, the REST API, and the MCP
 * endpoint over a shared dataset store.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDataDir } from '../core/paths.js';
import { DatasetStore } from '../core/store.js';
import { createLlmClient } from '../agent/llm.js';
import { createHttpServer } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the frontend.
 *
 * It has no build step, so it ships as source rather than as part of `dist`.
 * That means its path relative to the compiled entry point depends on how the
 * app was laid out at deploy time, and a wrong guess produces a blank page
 * with a 200 status — the worst kind of deployment failure, because nothing
 * looks broken. So: try the known layouts, and fail loudly if none matches.
 */
function resolveWebRoot(): string {
  /*
   * An explicitly configured path is honoured or rejected — never silently
   * replaced by a guess. Falling back would turn a typo in the deployment
   * config into a working server that quietly ignores it, which is far harder
   * to diagnose than an outright failure to start.
   */
  const configured = process.env['AGENTICS_WEB_ROOT'];
  if (configured) {
    if (existsSync(resolve(configured, 'index.html'))) return resolve(configured);
    console.error(
      `[server] AGENTICS_WEB_ROOT указывает на «${configured}», но index.html там нет. ` +
      'Путь задан явно, поэтому подстановка запасного каталога не выполняется.',
    );
    process.exit(1);
  }

  const candidates = [
    resolve(here, '../../src/web'), // репозиторий или образ: dist/server → <root>/src/web
    resolve(here, '../web'),        // если фронтенд скопирован рядом с dist
    resolve(process.cwd(), 'src/web'),
  ];

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) return candidate;
  }

  console.error(
    '[server] не найден каталог веб-интерфейса (index.html). Проверены пути:\n' +
    candidates.map((c) => `  - ${c}`).join('\n') +
    '\nУкажите каталог явно через AGENTICS_WEB_ROOT.',
  );
  process.exit(1);
}

const webRoot = resolveWebRoot();
const port = Number(process.env['PORT'] ?? 4173);
const host = process.env['HOST'] ?? '127.0.0.1';
const dataDir = resolveDataDir();

const store = new DatasetStore(dataDir);
const server = createHttpServer({ store, port, host, webRoot });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] порт ${port} уже занят. Освободите его или задайте другой через PORT.`);
  } else if (err.code === 'EACCES') {
    console.error(`[server] нет прав на порт ${port}. Порты ниже 1024 требуют привилегий — используйте порт выше 1024 и обратный прокси.`);
  } else {
    console.error('[server] не удалось запуститься:', err);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log('');
  console.log('  Agentics Analytics — data to insight');
  console.log('  ─────────────────────────────────────────────────');
  console.log(`  Веб-интерфейс   http://${shown}:${port}`);
  console.log(`  Проверка        http://${shown}:${port}/healthz`);
  console.log(`  MCP (HTTP)      http://${shown}:${port}/mcp`);
  console.log(`  MCP (stdio)     node dist/mcp/stdio.js`);
  console.log(`  Данные          ${dataDir}`);
  console.log(`  Фронтенд        ${webRoot}`);
  console.log(`  Наборов         ${store.list().length}`);
  console.log(
    `  Языковая модель ${
      createLlmClient()
        ? 'подключена (нарратив и вопросы на естественном языке)'
        : 'не настроена — анализ работает полностью, без LLM-формулировок'
    }`,
  );
  if (host === '0.0.0.0' || host === '::') {
    console.log('');
    console.log('  ВНИМАНИЕ: сервер слушает все интерфейсы и не имеет аутентификации.');
    console.log('  Не публикуйте его в интернет без обратного прокси с авторизацией.');
  }
  console.log('');
});

/**
 * Graceful shutdown. Orchestrators send SIGTERM and then SIGKILL after a grace
 * period; closing the listener first lets in-flight analyses finish instead of
 * being cut mid-response.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] получен ${signal}, завершаю текущие запросы.`);
    server.close(() => {
      console.log('[server] остановлен.');
      process.exit(0);
    });
    // Не висеть вечно на залипшем keep-alive соединении.
    setTimeout(() => {
      console.warn('[server] принудительное завершение по таймауту.');
      process.exit(0);
    }, 10_000).unref();
  });
}

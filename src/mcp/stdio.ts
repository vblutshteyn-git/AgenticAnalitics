#!/usr/bin/env node
/**
 * MCP over stdio — the transport local clients use (Claude Desktop, Claude Code).
 *
 * Nothing may be written to stdout except protocol frames: stdout *is* the
 * transport. Diagnostics go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { DatasetStore } from '../core/store.js';
import { buildMcpServer } from './server.js';
import { resolveDataDir } from '../core/paths.js';

async function main(): Promise<void> {
  const store = new DatasetStore(resolveDataDir());
  const server = buildMcpServer(store);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error(`[agentics-analytics] MCP сервер запущен (stdio), данные: ${resolveDataDir()}`);
}

main().catch((err) => {
  console.error('[agentics-analytics] не удалось запустить MCP сервер:', err);
  process.exit(1);
});

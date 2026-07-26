import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Where uploaded datasets live. Overridable so the MCP server and the web
 * server can be pointed at the same directory — sharing it means a dataset
 * uploaded by an agent over MCP is immediately visible in the browser, and
 * vice versa.
 */
export function resolveDataDir(): string {
  const configured = process.env['AGENTICS_DATA_DIR'];
  if (configured) return resolve(configured);
  return resolve(homedir(), '.agentics-analytics');
}

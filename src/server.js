import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createOdooClient } from './odoo-client.js';
import { OdooMcpError } from './errors.js';
import { tools } from './tools.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const asText = value => ({ type: 'text', text: JSON.stringify(value, null, 2) });

/**
 * Build the MCP server. The server starts without Odoo settings so clients can
 * list tools; each tool call then reports which settings are missing.
 */
export function createServer({ env = process.env, fetchImpl } = {}) {
  const server = new McpServer({ name: 'odoo-mcp', title: 'Odoo MCP server', version: VERSION });
  let client;
  const getClient = () => {
    if (client) return client;
    const { config, missing } = readConfig(env);
    if (missing.length) throw new OdooMcpError(`Odoo is not configured. Set ${missing.join(', ')} in the MCP server environment.`, 'CONFIGURATION_ERROR', { missing });
    client = createOdooClient({ ...config, fetchImpl });
    return client;
  };
  for (const tool of tools) {
    const annotations = tool.write
      ? { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
      : { readOnlyHint: true, openWorldHint: false };
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations }, async input => {
      try {
        return { content: [asText(await tool.handler(getClient(), input ?? {}, env))] };
      } catch (error) {
        const body = error instanceof OdooMcpError ? error.toJSON() : { error: { code: 'INTERNAL_ERROR', message: error.message } };
        return { isError: true, content: [asText(body)] };
      }
    });
  }
  return server;
}

export async function runStdio(options) {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

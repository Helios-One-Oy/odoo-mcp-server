import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = fileURLToPath(new URL('../bin/odoo-mcp.js', import.meta.url));
const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

test('bin --version prints the package version', () => {
  assert.equal(execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
});

test('bin starts a stdio MCP server that lists tools without Odoo settings', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin], env: { PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'odoo-mcp');
    assert.equal(client.getServerVersion().version, pkg.version);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    const result = await client.callTool({ name: 'lookup_supplier', arguments: { query: 'x' } });
    assert.ok(result.isError);
    assert.equal(JSON.parse(result.content[0].text).error.code, 'CONFIGURATION_ERROR');
  } finally {
    await client.close();
  }
});

test('package.json and server.json agree for the MCP Registry', async () => {
  const fs = await import('node:fs');
  const server = JSON.parse(fs.readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100);
});

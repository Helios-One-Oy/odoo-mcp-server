#!/usr/bin/env node
import { runStdio, VERSION } from '../src/server.js';

const arg = process.argv[2];
if (arg === '--version' || arg === '-v') {
  console.log(VERSION);
} else if (arg === '--help' || arg === '-h') {
  console.log(`odoo-mcp ${VERSION}: MCP server (stdio) for Odoo.
Environment: ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY (or ODOO_PASSWORD).
Optional: ODOO_MCP_ENABLE_WRITES=true, ODOO_TIMEOUT_MS.
Docs: https://github.com/Helios-One-Oy/odoo-mcp-server`);
} else {
  runStdio().catch(error => {
    console.error(`odoo-mcp: ${error.message}`);
    process.exit(1);
  });
}

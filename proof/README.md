# Proof

Evidence for the "What has been tested" section of the main README. All Odoo records are fictional and were created by the test in a throwaway database. These files are not part of the npm package.

| File | What it is |
|---|---|
| `run-live.sh` | Builds Odoo Community from source (branch 17.0 / 18.0 / 19.0) with PostgreSQL, packs this package with `npm pack`, installs the tarball in an empty project, runs `live-proof.mjs`, then one MCP Inspector CLI call. We ran it in disposable Daytona sandboxes. |
| `live-proof.mjs` | Seeds records over JSON-RPC, then drives the installed `odoo-mcp` bin over stdio with the MCP TypeScript SDK client and checks every result. |
| `odoo-17/`, `odoo-18/`, `odoo-19/` | Per version: `run.log` (console output), `session.json` (every MCP call with arguments and results, plus all checks), `inspector-lookup_supplier.json` (MCP Inspector CLI output). |
| `run-unit.sh`, `unit-tests.log` | `npm test` on Node.js 25 and Node.js 20. |
| `gitleaks-scan.log` | gitleaks 8.30.1 over the full git history: no leaks. |

Result on 24 October 2026: Odoo 17.0, 18.0 and 19.0 each PASS, 21 tool calls, 25 of 25 checks. Unit tests 25 of 25 on both Node versions.

# Odoo MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant (Claude Desktop, Claude Code, or any MCP client) read your Odoo sales, purchasing, manufacturing and stock data, and, only if you turn it on, update a purchase order line's promise date.

- 12 read tools and 1 write tool (listed below).
- **Read-only by default.** The write tool needs `ODOO_MCP_ENABLE_WRITES=true` on the server **and** an exact confirmation text on every call.
- Talks to Odoo's external JSON-RPC API (`/jsonrpc`) as the user you configure. Odoo's access rights apply.
- Runs locally over stdio. No telemetry; it connects only to your Odoo.

Built by [Helios One](https://heliosone.fi). MIT license.

## Quickstart (2 minutes)

You need Node.js 20 or newer and an Odoo user that can log in to the external API.

**1. Get an API key in Odoo** (recommended over a password): click your avatar, then *My Profile* / *Preferences*, open *Account Security*, click *New API Key*. Copy the key.

**2. Add the server to your MCP client.**

Claude Code:

```sh
claude mcp add odoo \
  -e ODOO_URL=https://odoo.example.com \
  -e ODOO_DB=mydb \
  -e ODOO_USERNAME=me@example.com \
  -e ODOO_API_KEY=your-api-key \
  -- npx -y @heliosone/odoo-mcp
```

Claude Desktop: open *Settings > Developer > Edit Config* and add this to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "npx",
      "args": ["-y", "@heliosone/odoo-mcp"],
      "env": {
        "ODOO_URL": "https://odoo.example.com",
        "ODOO_DB": "mydb",
        "ODOO_USERNAME": "me@example.com",
        "ODOO_API_KEY": "your-api-key"
      }
    }
  }
}
```

**3. Ask**, for example: *"Which purchase order lines are late, and by how many days?"* or *"What is the status of S00042?"*

## Settings

| Variable | Required | Meaning |
|---|---|---|
| `ODOO_URL` | yes | Base URL of your Odoo, e.g. `https://odoo.example.com` |
| `ODOO_DB` | yes | Database name |
| `ODOO_USERNAME` | yes | The user's login |
| `ODOO_API_KEY` | one of these two | API key of that user (used in place of the password) |
| `ODOO_PASSWORD` | | The user's password |
| `ODOO_MCP_ENABLE_WRITES` | no | `true` allows the write tool. Anything else keeps the server read-only. |
| `ODOO_TIMEOUT_MS` | no | Request timeout, default 30000 |

The server starts even when settings are missing, so your client can list the tools. Each call then returns `CONFIGURATION_ERROR` with the names of the missing settings.

## Tools

| Tool | What it returns |
|---|---|
| `list_open_sales_orders` | Confirmed sales orders not fully delivered (`includeQuotations` adds quotations) |
| `list_open_purchase_orders` | Confirmed purchase orders not fully received (`includeRfqs` adds RFQs) |
| `get_order_status` | One sales or purchase order with lines (ordered / delivered or received / invoiced) and its transfers. By id, number or customer/vendor reference. |
| `list_supplier_promise_dates` | Open lines on confirmed POs with the vendor's expected arrival date, soonest first |
| `list_late_purchase_lines` | PO lines past their expected arrival and not fully received, with `days_late` |
| `list_late_sales_lines` | Sales lines past their promised date and not fully delivered, with `days_late`. Promised date = the order's commitment date, else order date + the line's lead time. |
| `list_manufacturing_orders` | Manufacturing orders with state, quantity, planned dates, component availability |
| `list_work_orders` | Work orders: operation, work center, state, expected and actual duration |
| `list_shipments` | Receipts, deliveries or internal transfers; `lateOnly` for those past their scheduled date |
| `lookup_customer` | Contacts by name, email, reference or VAT, customers first |
| `lookup_supplier` | Contacts by name, email, reference or VAT, suppliers first |
| `get_inventory_on_hand` | Product quantities: on hand, forecast, incoming, outgoing |
| `update_po_line_promise_date` | **Write.** Sets one PO line's expected arrival date. See below. |

List tools take `limit` (default 50, max 500) and `offset`. Results are Odoo's own field values, plus a few computed fields (`qty_open`, `days_late`, `promised_date`). Fields that do not exist in your Odoo version are left out.

### The write tool

`update_po_line_promise_date` changes `date_planned` on one purchase order line (for example after a vendor confirms a new date). It runs only when both are true:

1. the server was started with `ODOO_MCP_ENABLE_WRITES=true`, and
2. the call includes `"confirmation": "CONFIRM update_po_line_promise_date"`.

Otherwise it returns `WRITES_DISABLED` or `CONFIRMATION_REQUIRED` and does not call Odoo. A date without a time is stored as 12:00 UTC so it shows as the same day in most time zones. The result shows the value before and after.

## What has been tested

Tested on 24 October 2026, with the packed npm tarball installed into an empty project and its `odoo-mcp` command driven over stdio by the official MCP TypeScript SDK client, against fresh self-hosted **Odoo Community 17.0, 18.0 and 19.0** (built from the official `odoo/odoo` branches; Sales, Purchase, Inventory and Manufacturing installed; fictional records). In each version:

- all 13 tools were listed and all 12 read tools returned the seeded records (21 tool calls and 25 checks per version, all passed);
- the write tool was refused with writes off (`WRITES_DISABLED`), refused without the confirmation text (`CONFIRMATION_REQUIRED`), then succeeded, and a direct Odoo read confirmed the new date;
- the server logged in with an Odoo API key; one session used the plain password instead, and a wrong password returned `AUTH_FAILED`;
- one call also went through the MCP Inspector CLI.

Logs: [`proof/`](proof/). Unit tests (`npm test`, against an in-memory fake Odoo) pass on Node.js 20 and 25.

**Not tested:** Odoo Online (odoo.com hosting) and Odoo.sh, Odoo Enterprise, Odoo versions before 17, multi-company setups, and large databases. Odoo Online offers the external API only on some plans. Odoo 19 deprecated `/jsonrpc` (removal planned for Odoo 22, fall 2028, and Odoo Online 21.1, winter 2027) in favour of its JSON-2 API; this server does not use JSON-2 yet. Odoo 19 logs a deprecation warning for each `/jsonrpc` call.

## Development

```sh
npm ci
npm test
```

`proof/run-live.sh 18.0` repeats the live test in a disposable Linux machine (it installs PostgreSQL and Odoo; do not run it on your workstation).

## Security

See [SECURITY.md](SECURITY.md). Use a dedicated Odoo user with only the rights the assistant needs.

## License

MIT, see [LICENSE](LICENSE).

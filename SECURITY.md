# Security

## How the server handles access

- **Read-only by default.** 12 of the 13 tools only call Odoo's `search_read`, `read` and `fields_get`.
- **One write tool, two locks.** `update_po_line_promise_date` changes one field (`date_planned`) on one purchase order line. It runs only when:
  1. the server process was started with `ODOO_MCP_ENABLE_WRITES=true`, and
  2. the call passes `confirmation: "CONFIRM update_po_line_promise_date"`.
  Otherwise it returns `WRITES_DISABLED` or `CONFIRMATION_REQUIRED` and makes no Odoo call.
- **Odoo permissions still apply.** The server acts as the Odoo user you configure. Use a dedicated user with only the access rights the assistant needs (for example Sales / Purchase / Inventory "User", read-only where possible).
- **Credentials stay in the server environment.** `ODOO_API_KEY` or `ODOO_PASSWORD` is read from the environment, sent only to your `ODOO_URL`, and never included in tool results or error messages. Prefer an Odoo API key (Preferences > Account Security > New API Key) over a password, so you can revoke it on its own. Never put credentials in prompts.
- **Use HTTPS** for any Odoo that is not on localhost.
- **No telemetry.** The server talks only to your Odoo.

## Reporting a vulnerability

Email touko@heliosone.fi with "odoo-mcp security" in the subject, or open a private GitHub security advisory on this repository. Please do not open a public issue for security problems. We aim to answer within 3 working days.

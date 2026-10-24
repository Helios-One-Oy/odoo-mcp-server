/** Machine-readable error returned to MCP clients as `{ error: { code, message, details } }`. */
export class OdooMcpError extends Error {
  constructor(message, code = 'ODOO_MCP_ERROR', details = {}) {
    super(message);
    this.name = 'OdooMcpError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const WRITE_FLAG = 'ODOO_MCP_ENABLE_WRITES';

/**
 * Writes need two things: the server process was started with
 * ODOO_MCP_ENABLE_WRITES=true, and the call carries the exact confirmation text.
 */
export function requireWriteAccess({ operation, confirmation, env = process.env }) {
  if (env[WRITE_FLAG] !== 'true') {
    throw new OdooMcpError(`Writes are disabled. Start the server with ${WRITE_FLAG}=true to allow ${operation}.`, 'WRITES_DISABLED', { operation });
  }
  const expected = `CONFIRM ${operation}`;
  if (confirmation !== expected) {
    throw new OdooMcpError(`This write needs confirmation="${expected}".`, 'CONFIRMATION_REQUIRED', { operation });
  }
}

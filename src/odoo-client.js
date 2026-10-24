import { OdooMcpError } from './errors.js';

/**
 * Minimal client for Odoo's external JSON-RPC API (`POST /jsonrpc`, services
 * `common` and `object`). See
 * https://www.odoo.com/documentation/18.0/developer/reference/external_api.html
 */
export function createOdooClient({ url, db, username, secret, timeoutMs = 30_000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new OdooMcpError('fetch is not available (Node.js 18 or newer is required)', 'CONFIGURATION_ERROR');
  let uidPromise;
  let requestId = 0;
  const fieldCache = new Map();

  async function rpc(service, method, args) {
    let response;
    try {
      response = await fetchImpl(`${url}/jsonrpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++requestId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new OdooMcpError(`Could not reach Odoo at ${url}: ${error.message}`, 'NETWORK_ERROR');
    }
    const text = await response.text();
    if (!response.ok) throw new OdooMcpError(`Odoo returned HTTP ${response.status}`, 'ODOO_HTTP_ERROR', { status: response.status });
    let data;
    try { data = JSON.parse(text); } catch { throw new OdooMcpError('Odoo returned a response that is not JSON', 'ODOO_BAD_RESPONSE'); }
    if (data.error) {
      const detail = data.error.data ?? {};
      throw new OdooMcpError(detail.message || data.error.message || 'Odoo error', 'ODOO_ERROR', { name: detail.name });
    }
    return data.result;
  }

  function uid() {
    uidPromise ??= rpc('common', 'authenticate', [db, username, secret, {}]).then(id => {
      if (!id) throw new OdooMcpError(`Odoo login failed for user "${username}" on database "${db}"`, 'AUTH_FAILED');
      return id;
    });
    uidPromise.catch(() => { uidPromise = undefined; });
    return uidPromise;
  }

  async function execute(model, method, args = [], kwargs = {}) {
    return rpc('object', 'execute_kw', [db, await uid(), secret, model, method, args, kwargs]);
  }

  /** Keep only fields that exist on this Odoo version (names differ between releases). */
  async function existingFields(model, wanted) {
    if (!fieldCache.has(model)) {
      fieldCache.set(model, execute(model, 'fields_get', [], { attributes: ['type'] }).then(fields => new Set(Object.keys(fields))));
      fieldCache.get(model).catch(() => fieldCache.delete(model));
    }
    const available = await fieldCache.get(model);
    return wanted.filter(name => available.has(name));
  }

  async function searchRead(model, domain, fields, { limit = 50, offset = 0, order = 'id desc' } = {}) {
    return execute(model, 'search_read', [domain], { fields: await existingFields(model, fields), limit, offset, order });
  }

  async function read(model, ids, fields) {
    if (!ids.length) return [];
    return execute(model, 'read', [ids, await existingFields(model, fields)]);
  }

  async function write(model, ids, values) {
    return execute(model, 'write', [ids, values]);
  }

  return { rpc, uid, execute, existingFields, searchRead, read, write };
}

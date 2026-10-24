import { OdooMcpError } from './errors.js';

/** Read the Odoo connection settings from the environment. Returns missing names instead of throwing. */
export function readConfig(env = process.env) {
  const config = {
    url: (env.ODOO_URL ?? '').trim().replace(/\/+$/, ''),
    db: (env.ODOO_DB ?? '').trim(),
    username: (env.ODOO_USERNAME ?? '').trim(),
    secret: env.ODOO_API_KEY || env.ODOO_PASSWORD || '',
    timeoutMs: Number(env.ODOO_TIMEOUT_MS) > 0 ? Number(env.ODOO_TIMEOUT_MS) : 30_000,
  };
  const missing = [];
  if (!config.url) missing.push('ODOO_URL');
  if (!config.db) missing.push('ODOO_DB');
  if (!config.username) missing.push('ODOO_USERNAME');
  if (!config.secret) missing.push('ODOO_API_KEY or ODOO_PASSWORD');
  if (config.url && !/^https?:\/\//i.test(config.url)) {
    throw new OdooMcpError('ODOO_URL must start with http:// or https://', 'CONFIGURATION_ERROR');
  }
  return { config, missing };
}

// Live proof: drive the installed npm tarball's `odoo-mcp` bin over stdio with the
// official MCP client against a fresh, self-hosted Odoo. Seeds fictional records
// through Odoo's JSON-RPC, then checks every tool, the default write refusal, the
// confirmation gate, one confirmed write and a direct read-back.
//
// Usage: node live-proof.mjs <installDir> <outFile>
// Env:   ODOO_URL ODOO_DB ODOO_USERNAME ODOO_PASSWORD [ODOO_API_KEY_FILE]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [installDir, outFile] = process.argv.slice(2);
const { ODOO_URL: url, ODOO_DB: db, ODOO_USERNAME: login, ODOO_PASSWORD: password } = process.env;
const apiKey = process.env.ODOO_API_KEY_FILE && existsSync(process.env.ODOO_API_KEY_FILE) ? readFileSync(process.env.ODOO_API_KEY_FILE, 'utf8').trim() : '';
const bin = join(installDir, 'node_modules', '.bin', 'odoo-mcp');
const log = { startedAt: new Date().toISOString(), odoo: {}, package: {}, auth: apiKey ? 'api-key' : 'password', calls: [], checks: [] };
let failures = 0;
const check = (name, ok, detail) => { log.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); };

// --- seed fictional data directly over JSON-RPC (admin) ---
let rid = 0;
async function rpc(service, method, args) {
  const res = await fetch(`${url}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++rid }) });
  const data = await res.json();
  if (data.error) throw new Error(`${service}.${method}: ${data.error.data?.message ?? data.error.message}`);
  return data.result;
}
const version = await rpc('common', 'version', []);
log.odoo = { server_version: version.server_version, server_serie: version.server_serie, protocol: 'JSON-RPC /jsonrpc' };
const uid = await rpc('common', 'authenticate', [db, login, password, {}]);
const x = (model, method, args = [], kwargs = {}) => rpc('object', 'execute_kw', [db, uid, password, model, method, args, kwargs]);
const fieldsOf = async model => new Set(Object.keys(await x(model, 'fields_get', [], { attributes: ['type'] })));

const customerId = await x('res.partner', 'create', [{ name: 'Proof Customer Oy (fictional)', email: 'buyer@customer.example', is_company: true }]);
const supplierId = await x('res.partner', 'create', [{ name: 'Proof Steel Supplier (fictional)', email: 'sales@supplier.example', is_company: true }]);
const productFields = await fieldsOf('product.template');
const productVals = { name: 'Proof Bracket (fictional)', default_code: 'PROOF-BRKT-1', list_price: 125, standard_price: 70, sale_ok: true, purchase_ok: true };
if (productFields.has('is_storable')) Object.assign(productVals, { type: 'consu', is_storable: true }); else if (productFields.has('detailed_type')) productVals.detailed_type = 'product'; else productVals.type = 'product';
const tmplId = await x('product.template', 'create', [productVals]);
const [product] = await x('product.product', 'search_read', [[['product_tmpl_id', '=', tmplId]]], { fields: ['id', 'uom_id'], limit: 1 });
const uomId = product.uom_id[0];
const lineUom = async model => ((await fieldsOf(model)).has('product_uom_id') ? 'product_uom_id' : 'product_uom');
const soUom = await lineUom('sale.order.line');
const poUom = await lineUom('purchase.order.line');

const saleId = await x('sale.order', 'create', [{ partner_id: customerId, client_order_ref: 'PROOF-CUST-PO-1', commitment_date: '2026-10-01 10:00:00', order_line: [[0, 0, { product_id: product.id, product_uom_qty: 3, [soUom]: uomId, price_unit: 125 }]] }]);
await x('sale.order', 'action_confirm', [[saleId]]);
const quoteId = await x('sale.order', 'create', [{ partner_id: customerId, order_line: [[0, 0, { product_id: product.id, product_uom_qty: 1, [soUom]: uomId, price_unit: 125 }]] }]);
const purchaseId = await x('purchase.order', 'create', [{ partner_id: supplierId, partner_ref: 'PROOF-VEND-SO-9', order_line: [[0, 0, { product_id: product.id, name: 'Proof Bracket (fictional)', product_qty: 5, [poUom]: uomId, price_unit: 70, date_planned: '2026-10-01 12:00:00' }]] }]);
await x('purchase.order', 'button_confirm', [[purchaseId]]);
const [poLine] = await x('purchase.order.line', 'search_read', [[['order_id', '=', purchaseId]]], { fields: ['id', 'date_planned'], limit: 1 });
if ((await fieldsOf('res.config.settings')).has('group_mrp_routings')) {
  // Turn on Manufacturing > Settings > Work Orders so BoM operations create work orders.
  const settingsId = await x('res.config.settings', 'create', [{ group_mrp_routings: true }]);
  await x('res.config.settings', 'execute', [[settingsId]]);
}
const workcenterId = await x('mrp.workcenter', 'create', [{ name: 'Proof Saw (fictional)' }]);
const bomId = await x('mrp.bom', 'create', [{ product_tmpl_id: tmplId, product_qty: 1, operation_ids: [[0, 0, { name: 'Cutting', workcenter_id: workcenterId, time_cycle_manual: 30 }]] }]);
const moId = await x('mrp.production', 'create', [{ product_id: product.id, product_qty: 2, product_uom_id: uomId, bom_id: bomId, origin: 'PROOF' }]);
await x('mrp.production', 'action_confirm', [[moId]]);
const [sale] = await x('sale.order', 'read', [[saleId], ['name']]);
const [purchase] = await x('purchase.order', 'read', [[purchaseId], ['name']]);
log.seed = { customerId, supplierId, productId: product.id, saleId, saleName: sale.name, quoteId, purchaseId, purchaseName: purchase.name, poLineId: poLine.id, poLineDatePlannedBefore: poLine.date_planned, moId, workcenterId };
console.log('seeded', JSON.stringify(log.seed));

// --- MCP over stdio through the installed package bin ---
const baseEnv = { PATH: process.env.PATH, ODOO_URL: url, ODOO_DB: db, ODOO_USERNAME: login, ...(apiKey ? { ODOO_API_KEY: apiKey } : { ODOO_PASSWORD: password }) };
async function open(label, extraEnv = {}) {
  const transport = new StdioClientTransport({ command: bin, args: [], env: { ...baseEnv, ...extraEnv }, stderr: 'inherit' });
  const client = new Client({ name: 'odoo-mcp-live-proof', version: '1.0.0' });
  await client.connect(transport);
  log.package = { ...log.package, serverInfo: client.getServerVersion() };
  return {
    client,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const body = JSON.parse(result.content[0].text);
      log.calls.push({ n: log.calls.length + 1, session: label, tool: name, arguments: args, isError: Boolean(result.isError), result: body });
      return { isError: Boolean(result.isError), body };
    },
  };
}
const ids = rows => rows.map(r => r.id);
const s = await open('default (writes not enabled)');
const { tools } = await s.client.listTools();
log.tools = tools.map(t => ({ name: t.name, readOnlyHint: t.annotations?.readOnlyHint }));
check('tools/list returns 13 tools', tools.length === 13, tools.map(t => t.name));

let r = await s.call('list_open_sales_orders');
check('list_open_sales_orders has the confirmed order', ids(r.body.rows).includes(saleId) && !ids(r.body.rows).includes(quoteId));
r = await s.call('list_open_sales_orders', { includeQuotations: true });
check('list_open_sales_orders includeQuotations adds the quotation', ids(r.body.rows).includes(quoteId));
r = await s.call('get_order_status', { name: sale.name });
check('get_order_status (sale, by number) returns lines and the delivery', r.body.order?.id === saleId && r.body.lines.length === 1 && r.body.transfers.some(t => t.picking_type_code === 'outgoing'));
r = await s.call('get_order_status', { orderType: 'purchase', name: 'PROOF-VEND-SO-9' });
check('get_order_status (purchase, by vendor ref) returns lines and the receipt', r.body.order?.id === purchaseId && r.body.lines[0]?.id === poLine.id && r.body.transfers.some(t => t.picking_type_code === 'incoming'));
r = await s.call('list_open_purchase_orders');
check('list_open_purchase_orders has the confirmed PO', ids(r.body.rows).includes(purchaseId));
r = await s.call('list_supplier_promise_dates', { supplier: 'Proof Steel' });
check('list_supplier_promise_dates has the open PO line', r.body.rows.some(row => row.id === poLine.id && row.qty_open === 5));
r = await s.call('list_late_purchase_lines', { asOf: '2026-10-24' });
const lateP = r.body.rows.find(row => row.id === poLine.id);
check('list_late_purchase_lines flags the PO line 23 days late', lateP?.days_late === 23, lateP && { days_late: lateP.days_late, qty_open: lateP.qty_open });
r = await s.call('list_late_sales_lines', { asOf: '2026-10-24' });
const lateS = r.body.rows.find(row => row.order_id?.[0] === saleId);
check('list_late_sales_lines flags the sales line from commitment_date', lateS?.promised_date === '2026-10-01' && lateS?.days_late === 23 && lateS?.qty_open === 3);
r = await s.call('list_manufacturing_orders', { query: 'Proof Bracket' });
check('list_manufacturing_orders has the confirmed MO', ids(r.body.rows).includes(moId));
r = await s.call('list_work_orders', { manufacturingOrderId: moId });
check('list_work_orders has the Cutting operation', r.body.rows.some(row => row.name === 'Cutting'));
r = await s.call('list_shipments', { direction: 'outgoing', query: sale.name });
check('list_shipments (outgoing) has the delivery for the sale', r.body.count >= 1);
r = await s.call('list_shipments', { direction: 'incoming', query: purchase.name });
check('list_shipments (incoming) has the receipt for the PO', r.body.count >= 1);
r = await s.call('lookup_customer', { query: 'Proof Customer' });
check('lookup_customer finds the customer', r.body.rows[0]?.id === customerId);
r = await s.call('lookup_supplier', { query: 'supplier.example' });
check('lookup_supplier finds the supplier by email', r.body.rows[0]?.id === supplierId);
r = await s.call('get_inventory_on_hand', { query: 'PROOF-BRKT' });
// incoming = 5 on the PO receipt + 2 finished by the MO; outgoing = 3 on the delivery; forecast = 0 + 7 - 3.
const inv = r.body.rows[0];
check('get_inventory_on_hand returns on-hand, incoming (PO 5 + MO 2), outgoing (SO 3) and forecast', inv?.id === product.id && inv.qty_available === 0 && inv.incoming_qty === 7 && inv.outgoing_qty === 3 && inv.virtual_available === 4, r.body.rows[0] && { qty_available: r.body.rows[0].qty_available, virtual_available: r.body.rows[0].virtual_available, incoming_qty: r.body.rows[0].incoming_qty, outgoing_qty: r.body.rows[0].outgoing_qty });
const writeArgs = { lineId: poLine.id, promiseDate: '2026-11-15', confirmation: 'CONFIRM update_po_line_promise_date' };
r = await s.call('update_po_line_promise_date', writeArgs);
check('write refused by default (WRITES_DISABLED)', r.isError && r.body.error.code === 'WRITES_DISABLED');
const [afterDenied] = await x('purchase.order.line', 'read', [[poLine.id], ['date_planned']]);
check('refused write left date_planned unchanged', afterDenied.date_planned === poLine.date_planned, afterDenied.date_planned);
await s.client.close();

const w = await open('writes enabled (ODOO_MCP_ENABLE_WRITES=true)', { ODOO_MCP_ENABLE_WRITES: 'true' });
r = await w.call('update_po_line_promise_date', { lineId: poLine.id, promiseDate: '2026-11-15' });
check('enabled server still needs the confirmation text', r.isError && r.body.error.code === 'CONFIRMATION_REQUIRED');
r = await w.call('update_po_line_promise_date', writeArgs);
check('confirmed write succeeds', !r.isError && r.body.updated === true && r.body.after === '2026-11-15 12:00:00', r.body);
const [readBack] = await x('purchase.order.line', 'read', [[poLine.id], ['date_planned']]);
log.readBack = { via: 'direct JSON-RPC purchase.order.line read (admin)', date_planned: readBack.date_planned };
check('direct read-back shows the new date_planned', readBack.date_planned === '2026-11-15 12:00:00', readBack.date_planned);
r = await w.call('list_supplier_promise_dates', { supplier: 'Proof Steel' });
check('MCP read-back shows the new promise date', r.body.rows.find(row => row.id === poLine.id)?.date_planned === '2026-11-15 12:00:00');
await w.client.close();

if (apiKey) {
  // One more session with the plain password instead of the API key.
  const p = await open('password auth', { ODOO_API_KEY: '', ODOO_PASSWORD: password });
  r = await p.call('lookup_supplier', { query: 'Proof Steel' });
  check('password auth also works', r.body.rows[0]?.id === supplierId);
  await p.client.close();
}
const bad = await open('wrong credentials', { ODOO_API_KEY: '', ODOO_PASSWORD: 'definitely-wrong' });
r = await bad.call('list_open_sales_orders');
check('wrong password gives AUTH_FAILED', r.isError && r.body.error.code === 'AUTH_FAILED');
await bad.client.close();

log.toolCalls = log.calls.length;
check('at least 15 MCP tool calls', log.calls.length >= 15, log.calls.length);
log.finishedAt = new Date().toISOString();
log.result = failures ? `FAIL (${failures})` : 'PASS';
writeFileSync(outFile, JSON.stringify(log, null, 2) + '\n');
console.log(`${log.result}: ${log.calls.length} tool calls, ${log.checks.length} checks, Odoo ${version.server_version}`);
process.exit(failures ? 1 : 0);

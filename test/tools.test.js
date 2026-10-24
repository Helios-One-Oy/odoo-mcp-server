import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { fakeOdoo, sample } from './fake-odoo.js';

const ENV = { ODOO_URL: 'https://odoo.example/', ODOO_DB: 'demo', ODOO_USERNAME: 'admin', ODOO_PASSWORD: 'secret-pass' };

async function connect({ env = ENV, data = sample, fieldsMissing, fetchImpl } = {}) {
  const odoo = fakeOdoo({ data, fieldsMissing });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ env, fetchImpl: fetchImpl ?? odoo.fetchImpl }).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
  };
  return { client, call, odoo };
}

const EXPECTED_TOOLS = ['get_inventory_on_hand', 'get_order_status', 'list_late_purchase_lines', 'list_late_sales_lines', 'list_manufacturing_orders', 'list_open_purchase_orders', 'list_open_sales_orders', 'list_shipments', 'list_supplier_promise_dates', 'list_work_orders', 'lookup_customer', 'lookup_supplier', 'update_po_line_promise_date'];

test('lists 13 tools with JSON input schemas and read-only hints', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), EXPECTED_TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 20);
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'update_po_line_promise_date');
  }
});

test('missing settings: tools still list, calls explain what to set', async () => {
  const { client, call } = await connect({ env: {} });
  assert.equal((await client.listTools()).tools.length, 13);
  const { isError, body } = await call('list_open_sales_orders');
  assert.ok(isError);
  assert.equal(body.error.code, 'CONFIGURATION_ERROR');
  assert.deepEqual(body.error.details.missing, ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY or ODOO_PASSWORD']);
});

test('uses JSON-RPC /jsonrpc with authenticate then execute_kw; trailing slash trimmed', async () => {
  const { call, odoo } = await connect();
  await call('lookup_customer', { query: 'sample' });
  assert.equal(odoo.calls[0].url, 'https://odoo.example/jsonrpc');
  assert.deepEqual([odoo.calls[0].service, odoo.calls[0].method], ['common', 'authenticate']);
  assert.ok(odoo.calls.slice(1).every(c => c.service === 'object' && c.method === 'execute_kw'));
  await call('lookup_supplier', { query: 'sample' });
  assert.equal(odoo.calls.filter(c => c.method === 'authenticate').length, 1, 'uid is cached');
});

test('wrong password gives AUTH_FAILED and never echoes the secret', async () => {
  const { call } = await connect({ env: { ...ENV, ODOO_PASSWORD: 'wrong-pass' } });
  const { isError, body } = await call('list_open_sales_orders');
  assert.ok(isError);
  assert.equal(body.error.code, 'AUTH_FAILED');
  assert.ok(!JSON.stringify(body).includes('wrong-pass'));
});

test('ODOO_API_KEY is used in place of the password', async () => {
  const { call } = await connect({ env: { ODOO_URL: ENV.ODOO_URL, ODOO_DB: 'demo', ODOO_USERNAME: 'admin', ODOO_API_KEY: 'secret-pass' } });
  assert.equal((await call('lookup_customer', { query: 'Sample' })).isError, false);
});

test('list_open_sales_orders: confirmed, not fully delivered; quotations on request; text filter', async () => {
  const { call } = await connect();
  assert.deepEqual((await call('list_open_sales_orders')).body.rows.map(r => r.name), ['S00001']);
  assert.deepEqual((await call('list_open_sales_orders', { includeQuotations: true })).body.rows.map(r => r.name).sort(), ['S00001', 'S00002']);
  assert.deepEqual((await call('list_open_sales_orders', { query: 'cust-po' })).body.rows.map(r => r.name), ['S00001']);
});

test('list_open_sales_orders skips delivery_status filter when the field does not exist', async () => {
  const { call } = await connect({ fieldsMissing: { 'sale.order': ['delivery_status'] } });
  const { body } = await call('list_open_sales_orders');
  assert.deepEqual(body.rows.map(r => r.name).sort(), ['S00001', 'S00003']);
  assert.ok(!('delivery_status' in body.rows[0]));
});

test('list_open_purchase_orders: confirmed, not fully received; RFQs on request', async () => {
  const { call } = await connect();
  assert.deepEqual((await call('list_open_purchase_orders')).body.rows.map(r => r.name), ['P00001']);
  assert.deepEqual((await call('list_open_purchase_orders', { includeRfqs: true })).body.rows.map(r => r.name).sort(), ['P00001', 'P00002']);
});

test('get_order_status returns header, product lines and transfers; by name or reference', async () => {
  const { call } = await connect();
  const sale = (await call('get_order_status', { name: 'S00001' })).body;
  assert.equal(sale.model, 'sale.order');
  assert.equal(sale.order.name, 'S00001');
  assert.deepEqual(sale.lines.map(l => l.id), [1], 'section lines dropped');
  assert.deepEqual(sale.transfers.map(t => t.name), ['WH/OUT/00001']);
  const purchase = (await call('get_order_status', { orderType: 'purchase', name: 'VEND-SO-9' })).body;
  assert.equal(purchase.order.name, 'P00001');
  assert.equal(purchase.lines.length, 2);
  const missing = await call('get_order_status', { orderType: 'purchase', orderId: 999 });
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal((await call('get_order_status', {})).body.error.code, 'INVALID_INPUT');
});

test('list_supplier_promise_dates: open lines on confirmed POs, soonest first', async () => {
  const { call } = await connect();
  const { body } = await call('list_supplier_promise_dates');
  assert.deepEqual(body.rows.map(r => r.id), [1]);
  assert.equal(body.rows[0].qty_open, 3);
  assert.deepEqual((await call('list_supplier_promise_dates', { includeReceived: true })).body.rows.map(r => r.id), [1, 2]);
  assert.equal((await call('list_supplier_promise_dates', { supplier: 'nobody' })).body.count, 0);
});

test('list_late_purchase_lines computes qty_open and days_late', async () => {
  const { call } = await connect();
  const { body } = await call('list_late_purchase_lines', { asOf: '2026-10-24' });
  assert.equal(body.asOf, '2026-10-24');
  assert.deepEqual(body.rows.map(r => [r.id, r.qty_open, r.days_late]), [[1, 3, 23]]);
  assert.equal((await call('list_late_purchase_lines', { asOf: '2026-09-01' })).body.count, 0);
});

test('list_late_sales_lines uses commitment_date, else order date + customer lead', async () => {
  const { call } = await connect();
  const { body } = await call('list_late_sales_lines', { asOf: '2026-10-24' });
  assert.deepEqual(body.rows.map(r => [r.id, r.promised_date, r.days_late, r.qty_open]), [[1, '2026-10-01', 23, 2], [4, '2026-10-08', 16, 2]]);
  assert.deepEqual((await call('list_late_sales_lines', { asOf: '2026-10-05' })).body.rows.map(r => r.id), [1]);
  assert.deepEqual((await call('list_late_sales_lines', { asOf: '2026-10-24', customer: 'both' })).body.rows.map(r => r.id), [4]);
});

test('paging applies to filtered rows', async () => {
  const { call } = await connect();
  const first = (await call('list_late_sales_lines', { asOf: '2026-10-24', limit: 1 })).body;
  const second = (await call('list_late_sales_lines', { asOf: '2026-10-24', limit: 1, offset: 1 })).body;
  assert.deepEqual([first.rows[0].id, second.rows[0].id], [1, 4]);
});

test('manufacturing orders, work orders, shipments, inventory', async () => {
  const { call } = await connect();
  assert.deepEqual((await call('list_manufacturing_orders')).body.rows.map(r => r.name), ['WH/MO/00001']);
  assert.equal((await call('list_manufacturing_orders', { includeDone: true })).body.count, 2);
  assert.deepEqual((await call('list_work_orders', { manufacturingOrderId: 1 })).body.rows.map(r => r.name), ['Cutting']);
  assert.equal((await call('list_work_orders', { manufacturingOrderId: 2 })).body.count, 0);
  assert.deepEqual((await call('list_shipments', { direction: 'incoming' })).body.rows.map(r => r.name), ['WH/IN/00001']);
  assert.deepEqual((await call('list_shipments', { lateOnly: true, asOf: '2026-10-24' })).body.rows.map(r => r.name), ['WH/OUT/00001']);
  assert.equal((await call('list_shipments', { includeDone: true })).body.count, 3);
  const stock = (await call('get_inventory_on_hand', { query: 'sku-1' })).body.rows;
  assert.deepEqual(stock.map(r => [r.default_code, r.qty_available, r.virtual_available]), [['SKU-1', 12, 10]]);
});

test('lookups rank customers and suppliers', async () => {
  const { call } = await connect();
  assert.equal((await call('lookup_customer', { query: 'sample' })).body.rows[0].name, 'Sample Customer Ltd');
  assert.equal((await call('lookup_supplier', { query: 'sample' })).body.rows[0].name, 'Sample Steel Supplier');
  assert.deepEqual((await call('lookup_customer', { query: 'hello@both' })).body.rows.map(r => r.id), [9]);
});

test('input validation rejects bad arguments before calling Odoo', async () => {
  const { client, odoo } = await connect();
  const result = await client.callTool({ name: 'list_open_sales_orders', arguments: { limit: 100000 } });
  assert.ok(result.isError);
  const bad = await client.callTool({ name: 'update_po_line_promise_date', arguments: { lineId: 1, promiseDate: 'next week' } });
  assert.ok(bad.isError);
  assert.equal(odoo.calls.length, 0);
});

test('write is refused by default even with the confirmation text', async () => {
  const { call, odoo } = await connect();
  const { isError, body } = await call('update_po_line_promise_date', { lineId: 1, promiseDate: '2026-11-15', confirmation: 'CONFIRM update_po_line_promise_date' });
  assert.ok(isError);
  assert.equal(body.error.code, 'WRITES_DISABLED');
  assert.equal(odoo.calls.length, 0, 'no Odoo call was made');
  assert.equal(odoo.db.data['purchase.order.line'][0].date_planned, '2026-10-01 12:00:00');
});

test('ODOO_MCP_ENABLE_WRITES must be exactly "true"', async () => {
  const { call } = await connect({ env: { ...ENV, ODOO_MCP_ENABLE_WRITES: '1' } });
  const { body } = await call('update_po_line_promise_date', { lineId: 1, promiseDate: '2026-11-15', confirmation: 'CONFIRM update_po_line_promise_date' });
  assert.equal(body.error.code, 'WRITES_DISABLED');
});

test('with writes enabled, the confirmation text is still required', async () => {
  const { call, odoo } = await connect({ env: { ...ENV, ODOO_MCP_ENABLE_WRITES: 'true' } });
  for (const confirmation of [undefined, 'yes', 'CONFIRM']) {
    const { body } = await call('update_po_line_promise_date', { lineId: 1, promiseDate: '2026-11-15', ...(confirmation ? { confirmation } : {}) });
    assert.equal(body.error.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal(odoo.calls.length, 0);
});

test('enabled and confirmed write updates date_planned and returns before/after', async () => {
  const { call, odoo } = await connect({ env: { ...ENV, ODOO_MCP_ENABLE_WRITES: 'true' } });
  const { isError, body } = await call('update_po_line_promise_date', { lineId: 1, promiseDate: '2026-11-15', confirmation: 'CONFIRM update_po_line_promise_date' });
  assert.equal(isError, false);
  assert.deepEqual([body.before, body.after], ['2026-10-01 12:00:00', '2026-11-15 12:00:00']);
  assert.equal(odoo.db.data['purchase.order.line'][0].date_planned, '2026-11-15 12:00:00');
  const writes = odoo.calls.filter(c => c.args?.[4] === 'write');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args.slice(3, 6), ['purchase.order.line', 'write', [[1], { date_planned: '2026-11-15 12:00:00' }]]);
  const missing = await call('update_po_line_promise_date', { lineId: 99, promiseDate: '2026-11-15', confirmation: 'CONFIRM update_po_line_promise_date' });
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('network and Odoo server errors are mapped to error codes', async () => {
  const down = await connect({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal((await down.call('list_shipments')).body.error.code, 'NETWORK_ERROR');
  const http = await connect({ fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'bad gateway' }) });
  assert.equal((await http.call('list_shipments')).body.error.code, 'ODOO_HTTP_ERROR');
  let n = 0;
  const odooError = await connect({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(n++ === 0 ? { result: 2 } : { error: { message: 'Odoo Server Error', data: { name: 'odoo.exceptions.AccessError', message: 'You are not allowed to access Transfers' } } }) }) });
  const { body } = await odooError.call('list_shipments');
  assert.deepEqual([body.error.code, body.error.message, body.error.details.name], ['ODOO_ERROR', 'You are not allowed to access Transfers', 'odoo.exceptions.AccessError']);
});

test('ODOO_URL must be http(s)', async () => {
  const { call } = await connect({ env: { ...ENV, ODOO_URL: 'odoo.example' } });
  assert.equal((await call('lookup_customer', { query: 'x' })).body.error.code, 'CONFIGURATION_ERROR');
});

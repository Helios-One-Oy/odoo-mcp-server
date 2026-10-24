// In-memory stand-in for Odoo's /jsonrpc endpoint, used by the unit tests.
// It implements just enough of the domain language for the domains this server sends.
// All data is fictional.

const get = (record, path, db) => {
  const parts = path.split('.');
  let value = record;
  parts.forEach((part, i) => {
    if (value == null) return;
    const raw = value[part];
    const last = i === parts.length - 1;
    value = !last && Array.isArray(raw) && db.relations[part] ? db.find(db.relations[part], raw[0]) : raw;
  });
  return value;
};
const isPair = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string';

function matchLeaf(record, [field, op, value], db) {
  let actual = get(record, field, db);
  if (isPair(actual)) actual = op === 'ilike' ? actual[1] : actual[0];
  switch (op) {
    case '=': return (actual ?? false) === value;
    case '!=': return (actual ?? false) !== value;
    case '<': return actual != null && actual !== false && String(actual) < String(value);
    case 'in': return value.includes(actual);
    case 'not in': return !value.includes(actual);
    case 'ilike': return String(actual ?? '').toLowerCase().includes(String(value).toLowerCase());
    default: throw new Error(`fake odoo: operator ${op}`);
  }
}

function matchDomain(record, domain, db) {
  const stack = [];
  for (let i = domain.length - 1; i >= 0; i--) {
    const item = domain[i];
    if (item === '|') { const a = stack.pop(); const b = stack.pop(); stack.push(a || b); }
    else if (item === '&') { const a = stack.pop(); const b = stack.pop(); stack.push(a && b); }
    else stack.push(matchLeaf(record, item, db));
  }
  return stack.every(Boolean);
}

export function fakeOdoo({ data, users = { admin: 'secret-pass' }, db: dbName = 'demo', fieldsMissing = {} } = {}) {
  const calls = [];
  const db = {
    data: structuredClone(data),
    relations: { partner_id: 'res.partner' },
    find(model, id) { return (this.data[model] ?? []).find(r => r.id === id); },
  };
  const fieldsOf = model => {
    const keys = new Set();
    for (const r of db.data[model] ?? []) Object.keys(r).forEach(k => keys.add(k));
    for (const k of fieldsMissing[model] ?? []) keys.delete(k);
    return keys;
  };
  const pick = (model, record, fields) => Object.fromEntries((fields?.length ? fields : Object.keys(record)).filter(f => fieldsOf(model).has(f)).map(f => [f, record[f] ?? false]));

  function execute(model, method, args, kwargs) {
    const rows = db.data[model] ?? [];
    const scoped = { ...db, relations: { ...db.relations, order_id: model.replace(/\.line$/, '') } };
    if (method === 'fields_get') return Object.fromEntries([...fieldsOf(model)].map(f => [f, { type: 'char' }]));
    if (method === 'search_read') {
      const [domain] = args;
      for (const f of kwargs.fields ?? []) if (!fieldsOf(model).has(f)) throw Object.assign(new Error(`Invalid field '${f}' on model '${model}'`), { odoo: true });
      const [key, dir] = String(kwargs.order ?? 'id asc').split(',')[0].trim().split(/\s+/);
      const sorted = rows.filter(r => matchDomain(r, domain, scoped)).sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      return sorted.slice(kwargs.offset ?? 0, (kwargs.offset ?? 0) + (kwargs.limit ?? 80)).map(r => pick(model, r, kwargs.fields));
    }
    if (method === 'read') {
      const [ids, fields] = args;
      return ids.map(id => {
        const r = rows.find(x => x.id === id);
        if (!r) throw Object.assign(new Error(`Record does not exist or has been deleted. (Record: ${model}(${id},))`), { odoo: true });
        return pick(model, r, fields);
      });
    }
    if (method === 'write') {
      const [ids, values] = args;
      for (const id of ids) Object.assign(rows.find(x => x.id === id), values);
      return true;
    }
    throw new Error(`fake odoo: method ${method}`);
  }

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, ...body.params });
    const reply = result => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    const fail = message => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 200, message: 'Odoo Server Error', data: { name: 'odoo.exceptions.ValidationError', message } } }) });
    const { service, method, args } = body.params;
    if (!url.endsWith('/jsonrpc')) return { ok: false, status: 404, text: async () => 'not found' };
    if (service === 'common' && method === 'authenticate') {
      const [database, login, password] = args;
      return reply(database === dbName && users[login] === password ? 2 : false);
    }
    if (service === 'object' && method === 'execute_kw') {
      const [database, uid, password, model, m, a = [], kw = {}] = args;
      if (database !== dbName || uid !== 2 || users.admin !== password) return fail('Access Denied');
      try { return reply(execute(model, m, a, kw)); } catch (error) { if (error.odoo) return fail(error.message); throw error; }
    }
    return fail(`unknown ${service}.${method}`);
  };
  return { fetchImpl, calls, db };
}

/** Fictional sample records shaped like Odoo 18 search_read output. */
export const sample = {
  'res.partner': [
    { id: 7, name: 'Sample Customer Ltd', email: 'buyer@customer.example', phone: false, city: 'Tampere', country_id: [73, 'Finland'], ref: 'C-100', vat: false, is_company: true, parent_id: false, customer_rank: 3, supplier_rank: 0 },
    { id: 8, name: 'Sample Steel Supplier', email: 'sales@supplier.example', phone: false, city: 'Oulu', country_id: [73, 'Finland'], ref: 'V-200', vat: false, is_company: true, parent_id: false, customer_rank: 0, supplier_rank: 5 },
    { id: 9, name: 'Sample Both Co', email: 'hello@both.example', phone: false, city: false, country_id: false, ref: false, vat: false, is_company: true, parent_id: false, customer_rank: 1, supplier_rank: 1 },
  ],
  'sale.order': [
    { id: 1, name: 'S00001', state: 'sale', partner_id: [7, 'Sample Customer Ltd'], client_order_ref: 'CUST-PO-1', date_order: '2026-09-20 08:00:00', commitment_date: '2026-10-01 10:00:00', expected_date: '2026-10-01 10:00:00', delivery_status: 'pending', invoice_status: 'to invoice', amount_total: 375, currency_id: [1, 'EUR'], user_id: [2, 'Admin'], order_line: [1, 2], picking_ids: [11] },
    { id: 2, name: 'S00002', state: 'draft', partner_id: [9, 'Sample Both Co'], client_order_ref: false, date_order: '2026-10-20 08:00:00', commitment_date: false, expected_date: '2026-10-27 08:00:00', delivery_status: false, invoice_status: 'no', amount_total: 100, currency_id: [1, 'EUR'], user_id: [2, 'Admin'], order_line: [3], picking_ids: [] },
    { id: 3, name: 'S00003', state: 'sale', partner_id: [9, 'Sample Both Co'], client_order_ref: false, date_order: '2026-10-01 08:00:00', commitment_date: false, expected_date: '2026-10-08 08:00:00', delivery_status: 'full', invoice_status: 'invoiced', amount_total: 50, currency_id: [1, 'EUR'], user_id: [2, 'Admin'], order_line: [4], picking_ids: [] },
  ],
  'sale.order.line': [
    { id: 1, order_id: [1, 'S00001'], product_id: [5, '[SKU-1] Bracket'], name: 'Bracket', product_uom_qty: 3, qty_delivered: 1, qty_invoiced: 0, customer_lead: 0, display_type: false },
    { id: 2, order_id: [1, 'S00001'], product_id: false, name: 'Section', product_uom_qty: 0, qty_delivered: 0, qty_invoiced: 0, customer_lead: 0, display_type: 'line_section' },
    { id: 3, order_id: [2, 'S00002'], product_id: [5, '[SKU-1] Bracket'], name: 'Bracket', product_uom_qty: 1, qty_delivered: 0, qty_invoiced: 0, customer_lead: 7, display_type: false },
    { id: 4, order_id: [3, 'S00003'], product_id: [5, '[SKU-1] Bracket'], name: 'Bracket', product_uom_qty: 2, qty_delivered: 0, qty_invoiced: 0, customer_lead: 7, display_type: false },
  ],
  'purchase.order': [
    { id: 1, name: 'P00001', state: 'purchase', partner_id: [8, 'Sample Steel Supplier'], partner_ref: 'VEND-SO-9', date_order: '2026-09-15 08:00:00', date_approve: '2026-09-15 09:00:00', date_planned: '2026-10-01 12:00:00', receipt_status: 'pending', invoice_status: 'no', amount_total: 350, currency_id: [1, 'EUR'], user_id: [2, 'Admin'], order_line: [1, 2], picking_ids: [12] },
    { id: 2, name: 'P00002', state: 'draft', partner_id: [8, 'Sample Steel Supplier'], partner_ref: false, date_order: '2026-10-20 08:00:00', date_approve: false, date_planned: '2026-11-20 12:00:00', receipt_status: false, invoice_status: 'no', amount_total: 70, currency_id: [1, 'EUR'], user_id: [2, 'Admin'], order_line: [3], picking_ids: [] },
  ],
  'purchase.order.line': [
    { id: 1, order_id: [1, 'P00001'], partner_id: [8, 'Sample Steel Supplier'], product_id: [5, '[SKU-1] Bracket'], name: 'Bracket', product_qty: 5, qty_received: 2, qty_invoiced: 0, date_planned: '2026-10-01 12:00:00', display_type: false },
    { id: 2, order_id: [1, 'P00001'], partner_id: [8, 'Sample Steel Supplier'], product_id: [6, '[SKU-2] Plate'], name: 'Plate', product_qty: 1, qty_received: 1, qty_invoiced: 0, date_planned: '2026-10-02 12:00:00', display_type: false },
    { id: 3, order_id: [2, 'P00002'], partner_id: [8, 'Sample Steel Supplier'], product_id: [5, '[SKU-1] Bracket'], name: 'Bracket', product_qty: 1, qty_received: 0, qty_invoiced: 0, date_planned: '2026-10-05 12:00:00', display_type: false },
  ],
  'stock.picking': [
    { id: 11, name: 'WH/OUT/00001', state: 'assigned', picking_type_code: 'outgoing', partner_id: [7, 'Sample Customer Ltd'], origin: 'S00001', scheduled_date: '2026-10-01 10:00:00', date_deadline: false, date_done: false },
    { id: 12, name: 'WH/IN/00001', state: 'assigned', picking_type_code: 'incoming', partner_id: [8, 'Sample Steel Supplier'], origin: 'P00001', scheduled_date: '2026-11-01 12:00:00', date_deadline: false, date_done: false },
    { id: 13, name: 'WH/IN/00000', state: 'done', picking_type_code: 'incoming', partner_id: [8, 'Sample Steel Supplier'], origin: 'P00000', scheduled_date: '2026-09-01 12:00:00', date_deadline: false, date_done: '2026-09-01 13:00:00' },
  ],
  'mrp.production': [
    { id: 1, name: 'WH/MO/00001', state: 'confirmed', product_id: [5, '[SKU-1] Bracket'], product_qty: 2, qty_producing: 0, product_uom_id: [1, 'Units'], date_start: '2026-10-25 08:00:00', date_finished: '2026-10-25 10:00:00', date_deadline: false, origin: 'S00001', reservation_state: 'confirmed', components_availability: 'Available' },
    { id: 2, name: 'WH/MO/00000', state: 'done', product_id: [5, '[SKU-1] Bracket'], product_qty: 1, qty_producing: 1, product_uom_id: [1, 'Units'], date_start: '2026-09-01 08:00:00', date_finished: '2026-09-01 10:00:00', date_deadline: false, origin: false, reservation_state: false, components_availability: false },
  ],
  'mrp.workorder': [
    { id: 1, name: 'Cutting', state: 'ready', production_id: [1, 'WH/MO/00001'], workcenter_id: [1, 'Saw'], product_id: [5, '[SKU-1] Bracket'], qty_production: 2, qty_produced: 0, date_start: false, date_finished: false, duration_expected: 30, duration: 0 },
  ],
  'product.product': [
    { id: 5, name: 'Bracket', default_code: 'SKU-1', type: 'consu', is_storable: true, uom_id: [1, 'Units'], qty_available: 12, virtual_available: 10, incoming_qty: 3, outgoing_qty: 5 },
    { id: 6, name: 'Plate', default_code: 'SKU-2', type: 'consu', is_storable: true, uom_id: [1, 'Units'], qty_available: 0, virtual_available: 1, incoming_qty: 1, outgoing_qty: 0 },
  ],
};

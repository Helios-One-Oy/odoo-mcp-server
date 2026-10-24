import * as z from 'zod';
import { OdooMcpError, requireWriteAccess } from './errors.js';

const MAX_SCAN = 5000;
const SCAN_BATCH = 200;

const limit = z.number().int().min(1).max(500).default(50).describe('Maximum rows to return (1-500, default 50).');
const offset = z.number().int().min(0).default(0).describe('Rows to skip, for paging (default 0).');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const asOf = isoDate.optional().describe('Cut-off date YYYY-MM-DD (default: today, UTC).');
const query = z.string().min(1).optional().describe('Text to match (case-insensitive, partial).');

const today = () => new Date().toISOString().slice(0, 10);
const m2oId = value => (Array.isArray(value) ? value[0] : value || null);
const dayMs = 86_400_000;
const daysBetween = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);
const addDays = (datetime, days) => new Date(Date.parse(`${datetime.slice(0, 10)}T00:00:00Z`) + Math.round(Number(days || 0) * dayMs)).toISOString().slice(0, 10);
const textDomain = (text, fields) => (text ? [...Array(fields.length - 1).fill('|'), ...fields.map(field => [field, 'ilike', text])] : []);
const page = (rows, input, extra = {}) => ({ count: rows.length, limit: input.limit, offset: input.offset, ...extra, rows });

/** Domain filter on a field only when this Odoo version has the field. */
async function optionalFilter(client, model, field, operator, value) {
  return (await client.existingFields(model, [field])).length ? [[field, operator, value]] : [];
}

/**
 * Some filters compare two fields of the same record (e.g. received < ordered),
 * which an Odoo domain cannot express. Scan in batches, filter here, and page the
 * filtered rows. Stops after MAX_SCAN records and reports `truncated`.
 */
async function scanFiltered(client, model, domain, fields, keep, { limit: max, offset: skip, order }) {
  const rows = [];
  let seen = 0;
  let matched = 0;
  for (let start = 0; start < MAX_SCAN; start += SCAN_BATCH) {
    const batch = await client.searchRead(model, domain, fields, { limit: SCAN_BATCH, offset: start, order });
    seen += batch.length;
    for (const row of await keep(batch)) {
      if (matched++ >= skip && rows.length < max) rows.push(row);
    }
    if (batch.length < SCAN_BATCH || rows.length >= max) return { rows, scanned: seen, truncated: false };
  }
  return { rows, scanned: seen, truncated: true };
}

const SALE_ORDER_FIELDS = ['id', 'name', 'state', 'partner_id', 'client_order_ref', 'date_order', 'commitment_date', 'expected_date', 'delivery_status', 'invoice_status', 'amount_total', 'currency_id', 'user_id'];
const SALE_LINE_FIELDS = ['id', 'order_id', 'product_id', 'name', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'customer_lead', 'display_type'];
const PURCHASE_ORDER_FIELDS = ['id', 'name', 'state', 'partner_id', 'partner_ref', 'date_order', 'date_approve', 'date_planned', 'receipt_status', 'invoice_status', 'amount_total', 'currency_id', 'user_id'];
const PURCHASE_LINE_FIELDS = ['id', 'order_id', 'partner_id', 'product_id', 'name', 'product_qty', 'qty_received', 'qty_invoiced', 'date_planned', 'display_type'];
const PICKING_FIELDS = ['id', 'name', 'state', 'picking_type_code', 'partner_id', 'origin', 'scheduled_date', 'date_deadline', 'date_done'];
const PARTNER_FIELDS = ['id', 'name', 'email', 'phone', 'city', 'country_id', 'ref', 'vat', 'is_company', 'parent_id', 'customer_rank', 'supplier_rank'];

async function getOrder(client, { orderType, orderId, name }) {
  const sale = orderType === 'sale';
  const model = sale ? 'sale.order' : 'purchase.order';
  const domain = orderId ? [['id', '=', orderId]] : ['|', ['name', '=', name], [sale ? 'client_order_ref' : 'partner_ref', '=', name]];
  const [order] = await client.searchRead(model, domain, [...(sale ? SALE_ORDER_FIELDS : PURCHASE_ORDER_FIELDS), 'order_line', 'picking_ids'], { limit: 1 });
  if (!order) throw new OdooMcpError(`No ${model} found for ${orderId ? `id ${orderId}` : `"${name}"`}`, 'NOT_FOUND');
  const { order_line: lineIds = [], picking_ids: pickingIds = [], ...header } = order;
  const lines = await client.read(sale ? 'sale.order.line' : 'purchase.order.line', lineIds, sale ? SALE_LINE_FIELDS : PURCHASE_LINE_FIELDS);
  const transfers = await client.read('stock.picking', pickingIds, PICKING_FIELDS);
  return { model, order: header, lines: lines.filter(line => !line.display_type), transfers };
}

/** Tool definitions. Each handler receives (client, input, env). */
export const tools = [
  {
    name: 'list_open_sales_orders',
    title: 'List open sales orders',
    description: 'Confirmed Odoo sales orders (state "sale") that are not fully delivered (delivery_status is not "full", where the field exists). includeQuotations adds draft and sent quotations. Newest first.',
    inputSchema: { query: query.describe('Match order number, customer name or customer reference.'), includeQuotations: z.boolean().default(false), limit, offset },
    async handler(client, input) {
      const states = input.includeQuotations ? ['draft', 'sent', 'sale'] : ['sale'];
      const domain = [['state', 'in', states], ...(await optionalFilter(client, 'sale.order', 'delivery_status', '!=', 'full')), ...textDomain(input.query, ['name', 'partner_id.name', 'client_order_ref'])];
      return page(await client.searchRead('sale.order', domain, SALE_ORDER_FIELDS, { limit: input.limit, offset: input.offset, order: 'date_order desc, id desc' }), input);
    },
  },
  {
    name: 'list_open_purchase_orders',
    title: 'List open purchase orders',
    description: 'Confirmed Odoo purchase orders (state "purchase" or locked "done") that are not fully received (receipt_status is not "full", where the field exists). includeRfqs adds draft, sent and to-approve RFQs. Newest first.',
    inputSchema: { query: query.describe('Match PO number, vendor name or vendor reference.'), includeRfqs: z.boolean().default(false), limit, offset },
    async handler(client, input) {
      const states = input.includeRfqs ? ['draft', 'sent', 'to approve', 'purchase', 'done'] : ['purchase', 'done'];
      const domain = [['state', 'in', states], ...(await optionalFilter(client, 'purchase.order', 'receipt_status', '!=', 'full')), ...textDomain(input.query, ['name', 'partner_id.name', 'partner_ref'])];
      return page(await client.searchRead('purchase.order', domain, PURCHASE_ORDER_FIELDS, { limit: input.limit, offset: input.offset, order: 'date_order desc, id desc' }), input);
    },
  },
  {
    name: 'get_order_status',
    title: 'Get order status',
    description: 'One sales or purchase order with its lines (ordered, delivered/received and invoiced quantities) and its transfers (receipts or deliveries). Find it by Odoo id or by order number / customer or vendor reference.',
    inputSchema: {
      orderType: z.enum(['sale', 'purchase']).default('sale'),
      orderId: z.number().int().positive().optional().describe('Odoo record id.'),
      name: z.string().min(1).optional().describe('Order number such as S00012 or P00007, or the customer/vendor reference.'),
    },
    async handler(client, input) {
      if (!input.orderId && !input.name) throw new OdooMcpError('Give orderId or name.', 'INVALID_INPUT');
      return getOrder(client, input);
    },
  },
  {
    name: 'list_supplier_promise_dates',
    title: 'List supplier promise dates',
    description: 'Purchase order lines on confirmed POs with the vendor\'s expected arrival date (date_planned), soonest first. By default only lines with quantity still to receive.',
    inputSchema: { supplier: query.describe('Match vendor name.'), includeReceived: z.boolean().default(false), limit, offset },
    async handler(client, input) {
      const domain = [['order_id.state', 'in', ['purchase', 'done']], ['display_type', '=', false], ...textDomain(input.supplier, ['partner_id.name'])];
      const keep = rows => rows.filter(row => input.includeReceived || row.qty_received < row.product_qty).map(row => ({ ...row, qty_open: row.product_qty - row.qty_received }));
      const result = await scanFiltered(client, 'purchase.order.line', domain, PURCHASE_LINE_FIELDS, keep, { ...input, order: 'date_planned asc, id asc' });
      return page(result.rows, input, { scanned: result.scanned, truncated: result.truncated });
    },
  },
  {
    name: 'list_late_purchase_lines',
    title: 'List late purchase lines',
    description: 'Lines on confirmed POs whose expected arrival (date_planned) is before asOf and that are not fully received. Adds qty_open and days_late.',
    inputSchema: { asOf, supplier: query.describe('Match vendor name.'), limit, offset },
    async handler(client, input) {
      const cutoff = input.asOf ?? today();
      const domain = [['order_id.state', 'in', ['purchase', 'done']], ['display_type', '=', false], ['date_planned', '<', cutoff], ...textDomain(input.supplier, ['partner_id.name'])];
      const keep = rows => rows.filter(row => row.qty_received < row.product_qty).map(row => ({ ...row, qty_open: row.product_qty - row.qty_received, days_late: daysBetween(row.date_planned.slice(0, 10), cutoff) }));
      const result = await scanFiltered(client, 'purchase.order.line', domain, PURCHASE_LINE_FIELDS, keep, { ...input, order: 'date_planned asc, id asc' });
      return page(result.rows, input, { asOf: cutoff, scanned: result.scanned, truncated: result.truncated });
    },
  },
  {
    name: 'list_late_sales_lines',
    title: 'List late sales lines',
    description: 'Lines on confirmed sales orders that are not fully delivered and whose promised date is before asOf. Promised date = the order\'s commitment_date if set, otherwise order date + the line\'s customer lead time (as Odoo computes it). Adds promised_date, qty_open and days_late.',
    inputSchema: { asOf, customer: query.describe('Match customer name.'), limit, offset },
    async handler(client, input) {
      const cutoff = input.asOf ?? today();
      const domain = [['order_id.state', '=', 'sale'], ['display_type', '=', false], ...textDomain(input.customer, ['order_id.partner_id.name'])];
      const keep = async rows => {
        const orders = await client.read('sale.order', [...new Set(rows.map(row => m2oId(row.order_id)))], ['id', 'name', 'partner_id', 'date_order', 'commitment_date']);
        const byId = new Map(orders.map(order => [order.id, order]));
        return rows.flatMap(row => {
          if (row.qty_delivered >= row.product_uom_qty) return [];
          const order = byId.get(m2oId(row.order_id));
          if (!order) return [];
          const promised = order.commitment_date ? order.commitment_date.slice(0, 10) : addDays(order.date_order, row.customer_lead);
          if (promised >= cutoff) return [];
          return [{ ...row, partner_id: order.partner_id, promised_date: promised, qty_open: row.product_uom_qty - row.qty_delivered, days_late: daysBetween(promised, cutoff) }];
        });
      };
      const result = await scanFiltered(client, 'sale.order.line', domain, SALE_LINE_FIELDS, keep, { ...input, order: 'order_id asc, id asc' });
      return page(result.rows, input, { asOf: cutoff, scanned: result.scanned, truncated: result.truncated });
    },
  },
  {
    name: 'list_manufacturing_orders',
    title: 'List manufacturing orders',
    description: 'Odoo manufacturing orders (mrp.production) with state, quantity, planned start/finish and component availability. By default excludes done and cancelled orders. Needs the Manufacturing app.',
    inputSchema: { query: query.describe('Match MO number, product or source document.'), includeDone: z.boolean().default(false), limit, offset },
    async handler(client, input) {
      const domain = [...(input.includeDone ? [] : [['state', 'not in', ['done', 'cancel']]]), ...textDomain(input.query, ['name', 'product_id.name', 'origin'])];
      const fields = ['id', 'name', 'state', 'product_id', 'product_qty', 'qty_producing', 'product_uom_id', 'date_start', 'date_finished', 'date_deadline', 'origin', 'reservation_state', 'components_availability'];
      return page(await client.searchRead('mrp.production', domain, fields, { limit: input.limit, offset: input.offset, order: 'id desc' }), input);
    },
  },
  {
    name: 'list_work_orders',
    title: 'List work orders',
    description: 'Odoo work orders (mrp.workorder): operation, work center, state, expected and actual duration. Optionally for one manufacturing order. By default excludes done and cancelled. Needs the Manufacturing app with work orders.',
    inputSchema: { manufacturingOrderId: z.number().int().positive().optional(), includeDone: z.boolean().default(false), limit, offset },
    async handler(client, input) {
      const domain = [...(input.includeDone ? [] : [['state', 'not in', ['done', 'cancel']]]), ...(input.manufacturingOrderId ? [['production_id', '=', input.manufacturingOrderId]] : [])];
      const fields = ['id', 'name', 'state', 'production_id', 'workcenter_id', 'product_id', 'qty_production', 'qty_produced', 'date_start', 'date_finished', 'duration_expected', 'duration'];
      return page(await client.searchRead('mrp.workorder', domain, fields, { limit: input.limit, offset: input.offset, order: 'id asc' }), input);
    },
  },
  {
    name: 'list_shipments',
    title: 'List shipments',
    description: 'Odoo transfers (stock.picking): receipts (incoming), deliveries (outgoing) or internal moves, with scheduled and done dates. By default only transfers not done or cancelled. lateOnly keeps those scheduled before asOf.',
    inputSchema: {
      direction: z.enum(['incoming', 'outgoing', 'internal', 'all']).default('all'),
      includeDone: z.boolean().default(false),
      lateOnly: z.boolean().default(false),
      asOf,
      query: query.describe('Match transfer number, source document or partner name.'),
      limit,
      offset,
    },
    async handler(client, input) {
      const domain = [
        ...(input.includeDone ? [] : [['state', 'not in', ['done', 'cancel']]]),
        ...(input.direction === 'all' ? [] : [['picking_type_code', '=', input.direction]]),
        ...(input.lateOnly ? [['scheduled_date', '<', input.asOf ?? today()]] : []),
        ...textDomain(input.query, ['name', 'origin', 'partner_id.name']),
      ];
      return page(await client.searchRead('stock.picking', domain, PICKING_FIELDS, { limit: input.limit, offset: input.offset, order: 'scheduled_date asc, id asc' }), input);
    },
  },
  {
    name: 'lookup_customer',
    title: 'Look up a customer',
    description: 'Find contacts (res.partner) by name, email, reference or VAT number. Contacts with more sales (customer_rank) come first.',
    inputSchema: { query: z.string().min(1).describe('Name, email, internal reference or VAT number (partial match).'), limit, offset },
    async handler(client, input) {
      const domain = textDomain(input.query, ['name', 'email', 'ref', 'vat']);
      return page(await client.searchRead('res.partner', domain, PARTNER_FIELDS, { limit: input.limit, offset: input.offset, order: 'customer_rank desc, id asc' }), input);
    },
  },
  {
    name: 'lookup_supplier',
    title: 'Look up a supplier',
    description: 'Find contacts (res.partner) by name, email, reference or VAT number. Contacts with more purchases (supplier_rank) come first.',
    inputSchema: { query: z.string().min(1).describe('Name, email, internal reference or VAT number (partial match).'), limit, offset },
    async handler(client, input) {
      const domain = textDomain(input.query, ['name', 'email', 'ref', 'vat']);
      return page(await client.searchRead('res.partner', domain, PARTNER_FIELDS, { limit: input.limit, offset: input.offset, order: 'supplier_rank desc, id asc' }), input);
    },
  },
  {
    name: 'get_inventory_on_hand',
    title: 'Get inventory on hand',
    description: 'Product quantities from Odoo (product.product): on hand (qty_available), forecasted (virtual_available), incoming and outgoing, across all warehouses.',
    inputSchema: { query: query.describe('Match product name or internal reference (SKU).'), productId: z.number().int().positive().optional(), limit, offset },
    async handler(client, input) {
      const domain = [...(input.productId ? [['id', '=', input.productId]] : []), ...textDomain(input.query, ['name', 'default_code'])];
      const fields = ['id', 'name', 'default_code', 'type', 'is_storable', 'uom_id', 'qty_available', 'virtual_available', 'incoming_qty', 'outgoing_qty'];
      return page(await client.searchRead('product.product', domain, fields, { limit: input.limit, offset: input.offset, order: 'default_code asc, id asc' }), input);
    },
  },
  {
    name: 'update_po_line_promise_date',
    title: 'Update a PO line promise date',
    write: true,
    description: 'WRITE. Sets the expected arrival date (date_planned) of one purchase order line, e.g. after a vendor confirms a new date. Refused unless the server was started with ODOO_MCP_ENABLE_WRITES=true AND confirmation is exactly "CONFIRM update_po_line_promise_date". A date without a time is stored as 12:00 UTC. Returns the value before and after.',
    inputSchema: {
      lineId: z.number().int().positive().describe('purchase.order.line id (see list_supplier_promise_dates).'),
      promiseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/, 'Use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS (UTC)'),
      confirmation: z.string().optional().describe('Must be exactly "CONFIRM update_po_line_promise_date".'),
    },
    async handler(client, input, env) {
      requireWriteAccess({ operation: 'update_po_line_promise_date', confirmation: input.confirmation, env });
      const fields = ['id', 'order_id', 'product_id', 'date_planned'];
      const [before] = await client.searchRead('purchase.order.line', [['id', '=', input.lineId]], fields, { limit: 1 });
      if (!before) throw new OdooMcpError(`No purchase.order.line with id ${input.lineId}`, 'NOT_FOUND');
      const value = input.promiseDate.length === 10 ? `${input.promiseDate} 12:00:00` : input.promiseDate;
      await client.write('purchase.order.line', [input.lineId], { date_planned: value });
      const [after] = await client.read('purchase.order.line', [input.lineId], fields);
      return { updated: true, lineId: input.lineId, order: before.order_id, before: before.date_planned, after: after.date_planned };
    },
  },
];

'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');

async function buyerFor(client, userId) {
  const result = await client.query('SELECT buyer_id FROM master.buyers WHERE user_id = $1 AND is_active = TRUE', [userId]);
  if (!result.rowCount) throw new AppError(403, 'BUYER_ACCOUNT_REQUIRED', 'An active customer account is required to place orders.');
  return result.rows[0].buyer_id;
}
function validateValue(attribute, rawValue) {
  let valueText = null; let valueNumeric = null; let valueBoolean = null;
  if (['TEXT', 'SELECT'].includes(attribute.data_type)) {
    valueText = String(rawValue);
    if (valueText.length > 500) throw new AppError(400, 'INVALID_ATTRIBUTE', `${attribute.label} must be 500 characters or fewer.`);
    if (attribute.data_type === 'SELECT' && !attribute.allowed_values.includes(valueText)) throw new AppError(400, 'INVALID_ATTRIBUTE', `Choose a valid option for ${attribute.label}.`);
  } else if (attribute.data_type === 'NUMBER') {
    valueNumeric = Number(rawValue);
    if (!Number.isFinite(valueNumeric) || (attribute.minimum_numeric_value != null && valueNumeric < Number(attribute.minimum_numeric_value)) || (attribute.maximum_numeric_value != null && valueNumeric > Number(attribute.maximum_numeric_value))) throw new AppError(400, 'INVALID_ATTRIBUTE', `${attribute.label} is outside its allowed range.`);
  } else if (attribute.data_type === 'BOOLEAN') {
    if (![true, false, 'true', 'false'].includes(rawValue)) throw new AppError(400, 'INVALID_ATTRIBUTE', `${attribute.label} must be true or false.`);
    valueBoolean = rawValue === true || rawValue === 'true';
  }
  return { valueText, valueNumeric, valueBoolean };
}
function dateIsValid(date) {
  if (!date) return true;
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
async function createOrder(userId, order) {
  if (!dateIsValid(order.requiredByDate)) throw new AppError(400, 'INVALID_DATE', 'Required delivery date is not a valid calendar date.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, TRUE)", [String(userId)]);
    const buyerId = await buyerFor(client, userId);
    if (order.requiredByDate) {
      const today = (await client.query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
      if (order.requiredByDate < today) throw new AppError(400, 'INVALID_DATE', 'Required delivery date cannot be earlier than today.');
    }
    const address = await client.query(`SELECT address_id FROM master.buyer_addresses
      WHERE address_id = $1 AND buyer_id = $2 AND address_type IN ('SHIPPING','BOTH') FOR SHARE`, [order.shippingAddressId, buyerId]);
    if (!address.rowCount) throw new AppError(400, 'INVALID_SHIPPING_ADDRESS', 'Choose an active shipping address saved to your account.');

    const lines = [];
    let maxLeadTime = 0;
    for (const requested of order.items) {
      const productResult = await client.query(`SELECT ft.fabric_type_id, ft.fabric_code, ft.fabric_name, ft.weave, ft.gsm, ft.width_inch,
        ft.default_rate_per_meter, ft.default_tax_percent, ft.minimum_order_quantity, ft.order_unit_code, ft.lead_time_days
        FROM master.fabric_types ft WHERE ft.fabric_type_id = $1 AND ft.is_active AND ft.is_published FOR SHARE`, [requested.productId]);
      const product = productResult.rows[0];
      if (!product) throw new AppError(400, 'PRODUCT_UNAVAILABLE', 'One of the selected products is no longer available.');
      if (product.order_unit_code !== 'MTR') throw new AppError(400, 'UNSUPPORTED_ORDER_UNIT', 'Customer orders currently support metres only.');
      if (requested.quantityMeters < Number(product.minimum_order_quantity)) throw new AppError(400, 'MINIMUM_ORDER_QUANTITY', `${product.fabric_name} has a minimum order of ${product.minimum_order_quantity} metres.`);
      const colour = await client.query(`SELECT c.colour_id, c.colour_name, c.hex_code FROM master.fabric_type_colours fc
        JOIN master.colours c ON c.colour_id = fc.colour_id AND c.is_active
        WHERE fc.fabric_type_id = $1 AND fc.colour_id = $2 AND fc.is_active`, [product.fabric_type_id, requested.colourId]);
      if (!colour.rowCount) throw new AppError(400, 'INVALID_COLOUR', `The selected colour is not available for ${product.fabric_name}.`);

      const configured = await client.query(`SELECT d.attribute_id, d.attribute_code, d.label, d.data_type,
        fta.allowed_values, fta.customer_configurable, fta.required_for_order, fta.minimum_numeric_value,
        fta.maximum_numeric_value, fta.requires_owner_confirmation
        FROM master.fabric_type_attributes fta JOIN master.product_attribute_definitions d ON d.attribute_id = fta.attribute_id
        WHERE fta.fabric_type_id = $1 AND fta.is_active AND d.is_active`, [product.fabric_type_id]);
      const submitted = new Map(requested.attributes.map((attribute) => [attribute.attributeCode, attribute.value]));
      if (submitted.size !== requested.attributes.length) throw new AppError(400, 'DUPLICATE_ATTRIBUTE', 'An order line contains a duplicate attribute.');
      const definitions = new Map(configured.rows.map((attribute) => [attribute.attribute_code, attribute]));
      for (const code of submitted.keys()) {
        const definition = definitions.get(code);
        if (!definition || !definition.customer_configurable) throw new AppError(400, 'INVALID_ATTRIBUTE', `${code} is not a customer-configurable option for ${product.fabric_name}.`);
      }
      const attributes = [];
      let requiresOwnerConfirmation = false;
      for (const definition of configured.rows) {
        const hasValue = submitted.has(definition.attribute_code);
        if (definition.required_for_order && !hasValue) throw new AppError(400, 'REQUIRED_ATTRIBUTE', `${definition.label} is required for ${product.fabric_name}.`);
        if (!hasValue) continue;
        if (!definition.customer_configurable) throw new AppError(400, 'INVALID_ATTRIBUTE', `${definition.label} cannot be changed by customers.`);
        attributes.push({ definition, ...validateValue(definition, submitted.get(definition.attribute_code)) });
        requiresOwnerConfirmation ||= definition.requires_owner_confirmation;
      }
      maxLeadTime = Math.max(maxLeadTime, Number(product.lead_time_days));
      lines.push({ requested, product, colour: colour.rows[0], attributes, requiresOwnerConfirmation });
    }
    const insertedOrder = await client.query(`INSERT INTO sales.orders(buyer_id, placed_by, required_by_date, shipping_address_id)
      VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE + $4::integer), $5) RETURNING order_id, order_no, order_date, required_by_date, status`, [buyerId, userId, order.requiredByDate, maxLeadTime, order.shippingAddressId]);
    const header = insertedOrder.rows[0];
    const responseLines = [];
    let ownerConfirmationRequired = false;
    for (let index = 0; index < lines.length; index += 1) {
      const { requested, product, colour, attributes, requiresOwnerConfirmation } = lines[index];
      const lineResult = await client.query(`INSERT INTO sales.order_items(order_id, line_no, fabric_type_id, colour_id, quantity_m, rate_per_m, tax_percent)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING order_item_id, line_no, quantity_m, rate_per_m, tax_percent, line_subtotal, line_tax, line_total`, [header.order_id, index + 1, product.fabric_type_id, colour.colour_id, requested.quantityMeters, product.default_rate_per_meter, product.default_tax_percent]);
      const insertedLine = lineResult.rows[0];
      for (const attribute of attributes) await client.query(`INSERT INTO sales.order_item_attributes(order_item_id, attribute_id, attribute_label_snapshot, unit_code_snapshot, value_text, value_numeric, value_boolean, requires_owner_confirmation_snapshot)
        VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`, [insertedLine.order_item_id, attribute.definition.attribute_id, attribute.definition.label, attribute.valueText, attribute.valueNumeric, attribute.valueBoolean, attribute.definition.requires_owner_confirmation]);
      responseLines.push({ ...insertedLine, product: { id: String(product.fabric_type_id), sku: product.fabric_code, title: product.fabric_name, weave: product.weave, gsm: product.gsm, width_inch: product.width_inch }, colour: colour.colour_name, attributes: attributes.map((item) => ({ code: item.definition.attribute_code, label: item.definition.label, value: item.valueText ?? item.valueNumeric ?? item.valueBoolean, requiresOwnerConfirmation: item.definition.requires_owner_confirmation })) });
      ownerConfirmationRequired ||= requiresOwnerConfirmation;
    }
    await client.query('COMMIT');
    return { ...header, order_id: String(header.order_id), lines: responseLines, requiresOwnerConfirmation: ownerConfirmationRequired };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function getOrders({ userId, roleCode, orderId, limit = 20, offset = 0 }) {
  if (orderId && !/^[1-9]\d*$/.test(String(orderId))) throw new AppError(400, 'INVALID_ID', 'Order ID is invalid.');
  const conditions = []; const params = [];
  if (roleCode !== 'OWNER') { params.push(await (async () => { const c = await pool.connect(); try { return await buyerFor(c, userId); } finally { c.release(); } })()); conditions.push(`o.buyer_id = $${params.length}`); }
  if (orderId) { params.push(orderId); conditions.push(`o.order_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  const result = await pool.query(`SELECT o.order_id, o.order_no, o.order_date, o.required_by_date, o.status, o.shipping_address_id,
      b.company_name, t.line_count, t.ordered_meters, t.produced_meters, t.dispatch_percent
    FROM sales.orders o JOIN master.buyers b ON b.buyer_id = o.buyer_id
    LEFT JOIN reporting.customer_order_tracking t ON t.order_id = o.order_id
    ${where} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  if (orderId && !result.rowCount) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order was not found.');
  const orders = [];
  for (const row of result.rows) {
    const itemResult = await pool.query(`SELECT oi.order_item_id, oi.line_no, oi.quantity_m, oi.rate_per_m, oi.tax_percent, oi.line_subtotal, oi.line_tax, oi.line_total,
      ft.fabric_code AS sku, ft.fabric_name AS title, ft.weave, ft.gsm, ft.width_inch, c.colour_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('label', a.attribute_label_snapshot, 'value', COALESCE(a.value_text, a.value_numeric::text, a.value_boolean::text), 'requiresOwnerConfirmation', a.requires_owner_confirmation_snapshot)) FROM sales.order_item_attributes a WHERE a.order_item_id = oi.order_item_id), '[]'::jsonb) AS attributes
      FROM sales.order_items oi JOIN master.fabric_types ft ON ft.fabric_type_id = oi.fabric_type_id JOIN master.colours c ON c.colour_id = oi.colour_id
      WHERE oi.order_id = $1 ORDER BY oi.line_no`, [row.order_id]);
    orders.push({ ...row, order_id: String(row.order_id), items: itemResult.rows.map((line) => ({ ...line, order_item_id: String(line.order_item_id), quantity_m: Number(line.quantity_m), rate_per_m: Number(line.rate_per_m), tax_percent: Number(line.tax_percent), line_subtotal: Number(line.line_subtotal), line_tax: Number(line.line_tax), line_total: Number(line.line_total), attributes: line.attributes || [] })) });
  }
  return orderId ? orders[0] : orders;
}
async function getBuyerAddresses(userId) {
  const result = await pool.query(`SELECT a.address_id, a.label, a.line1, a.line2, a.city, a.state, a.pincode, a.country, a.is_default
    FROM master.buyer_addresses a JOIN master.buyers b ON b.buyer_id = a.buyer_id
    WHERE b.user_id = $1 AND b.is_active AND a.address_type IN ('SHIPPING','BOTH') ORDER BY a.is_default DESC, a.address_id`, [userId]);
  return result.rows.map((row) => ({ ...row, address_id: String(row.address_id) }));
}
async function createBuyerAddress(userId, address) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const buyerId = await buyerFor(client, userId);
    await client.query('SELECT buyer_id FROM master.buyers WHERE buyer_id = $1 FOR UPDATE', [buyerId]);
    const existing = await client.query(`SELECT EXISTS (SELECT 1 FROM master.buyer_addresses
      WHERE buyer_id = $1 AND address_type IN ('SHIPPING','BOTH') AND is_default) AS has_default`, [buyerId]);
    const makeDefault = address.isDefault || !existing.rows[0].has_default;
    if (makeDefault) await client.query("UPDATE master.buyer_addresses SET is_default = false WHERE buyer_id = $1 AND address_type IN ('SHIPPING','BOTH') AND is_default", [buyerId]);
    const result = await client.query(`INSERT INTO master.buyer_addresses
      (buyer_id, address_type, label, line1, line2, city, state, pincode, country, is_default)
      VALUES ($1, 'BOTH', $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING address_id, label, line1, line2, city, state, pincode, country, is_default`,
    [buyerId, address.label, address.line1, address.line2, address.city, address.state, address.pincode, address.country, makeDefault]);
    await client.query('COMMIT');
    return { ...result.rows[0], address_id: String(result.rows[0].address_id) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function deleteBuyerAddress(userId, addressId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const buyerId = await buyerFor(client, userId);
    await client.query('SELECT buyer_id FROM master.buyers WHERE buyer_id = $1 FOR UPDATE', [buyerId]);
    const owned = await client.query(`SELECT address_id FROM master.buyer_addresses
      WHERE address_id = $1 AND buyer_id = $2 AND address_type IN ('SHIPPING','BOTH') FOR UPDATE`, [addressId, buyerId]);
    if (!owned.rowCount) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Address was not found.');
    const usedByOrder = await client.query('SELECT EXISTS (SELECT 1 FROM sales.orders WHERE shipping_address_id = $1) AS used', [addressId]);
    if (usedByOrder.rows[0].used) throw new AppError(409, 'ADDRESS_IN_USE', 'This address is attached to an order and cannot be deleted.');
    const deleted = await client.query(`DELETE FROM master.buyer_addresses
      WHERE address_id = $1 AND buyer_id = $2 AND address_type IN ('SHIPPING','BOTH')
      RETURNING is_default`, [addressId, buyerId]);
    if (!deleted.rowCount) throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Address was not found.');
    if (deleted.rows[0].is_default) {
      const replacement = await client.query(`SELECT address_id FROM master.buyer_addresses
        WHERE buyer_id = $1 AND address_type IN ('SHIPPING','BOTH') AND NOT is_default ORDER BY address_id LIMIT 1`, [buyerId]);
      const stillHasDefault = await client.query(`SELECT EXISTS (SELECT 1 FROM master.buyer_addresses
        WHERE buyer_id = $1 AND address_type IN ('SHIPPING','BOTH') AND is_default) AS has_default`, [buyerId]);
      if (replacement.rowCount && !stillHasDefault.rows[0].has_default) await client.query('UPDATE master.buyer_addresses SET is_default = true WHERE address_id = $1', [replacement.rows[0].address_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  } finally { client.release(); }
}
module.exports = { createOrder, getOrders, getBuyerAddresses, createBuyerAddress, deleteBuyerAddress };

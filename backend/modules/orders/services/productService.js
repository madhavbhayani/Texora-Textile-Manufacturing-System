'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');

const catalogColumns = `product_id, sku, title, description, image_url, product_category, weave, gsm, width_inch,
  unit_price, tax_percent, minimum_order_quantity, order_unit_code, order_unit_name, lead_time_days,
  available_colours, attributes`;
function parseId(value, label = 'Product') {
  if (!/^[1-9]\d*$/.test(String(value))) throw new AppError(400, 'INVALID_ID', `${label} ID is invalid.`);
  return value;
}
function publicProduct(row) {
  return { ...row, product_id: String(row.product_id), unit_price: Number(row.unit_price), tax_percent: Number(row.tax_percent), minimum_order_quantity: Number(row.minimum_order_quantity), gsm: row.gsm == null ? null : Number(row.gsm), width_inch: row.width_inch == null ? null : Number(row.width_inch), lead_time_days: Number(row.lead_time_days), available_colours: row.available_colours || [], attributes: row.attributes || [] };
}
async function listPublic({ search = '', category = '', weave = '', minGsm, maxGsm, limit = 24, offset = 0 } = {}) {
  const result = await pool.query(
    `SELECT ${catalogColumns} FROM reporting.product_catalog
      WHERE ($1::text = '' OR title ILIKE '%' || $1 || '%' OR sku ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
        AND ($2::text = '' OR product_category = $2)
        AND ($3::text = '' OR weave ILIKE $3)
        AND ($4::integer IS NULL OR gsm >= $4)
        AND ($5::integer IS NULL OR gsm <= $5)
      ORDER BY title LIMIT $6 OFFSET $7`, [search, category, weave, minGsm, maxGsm, limit, offset],
  );
  return result.rows.map(publicProduct);
}
async function getPublic(productId) {
  parseId(productId);
  const result = await pool.query(`SELECT ${catalogColumns} FROM reporting.product_catalog WHERE product_id = $1`, [productId]);
  if (!result.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'This product is not available.');
  return publicProduct(result.rows[0]);
}
async function listOwner({ limit = 24, offset = 0 } = {}) {
  const result = await pool.query(`SELECT fabric_type_id, fabric_code, fabric_name, product_description, image_url,
    product_category, weave, gsm, width_inch, default_rate_per_meter, default_tax_percent,
    estimated_cost_per_meter, minimum_order_quantity, order_unit_code, lead_time_days, is_active, is_published
    FROM master.fabric_types ORDER BY fabric_name LIMIT $1 OFFSET $2`, [limit, offset]);
  return result.rows.map((row) => ({ ...row, fabric_type_id: String(row.fabric_type_id) }));
}
async function getOwner(productId) {
  parseId(productId);
  const result = await pool.query(`SELECT fabric_type_id, fabric_code, fabric_name, product_description, image_url,
    product_category, weave, gsm, width_inch, hsn_code, default_rate_per_meter, default_tax_percent,
    estimated_cost_per_meter, minimum_order_quantity, order_unit_code, lead_time_days, is_active, is_published
    FROM master.fabric_types WHERE fabric_type_id = $1`, [productId]);
  if (!result.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
  const product = result.rows[0];
  const [colours, bom, attributes] = await Promise.all([
    pool.query(`SELECT c.colour_id, c.colour_name, c.hex_code, fc.is_default FROM master.fabric_type_colours fc
      JOIN master.colours c ON c.colour_id = fc.colour_id WHERE fc.fabric_type_id = $1 AND fc.is_active ORDER BY c.colour_name`, [productId]),
    pool.query(`SELECT y.yarn_type_id, y.yarn_code, y.yarn_name, fb.kg_per_meter, fb.wastage_percent
      FROM master.fabric_bom fb JOIN master.yarn_types y ON y.yarn_type_id = fb.yarn_type_id
      WHERE fb.fabric_type_id = $1 ORDER BY y.yarn_name`, [productId]),
    pool.query(`SELECT d.attribute_code, d.label, d.data_type, d.unit_code, fta.default_value_text,
      fta.default_value_numeric, fta.default_value_boolean, fta.allowed_values, fta.customer_configurable,
      fta.required_for_order, fta.minimum_numeric_value, fta.maximum_numeric_value,
      fta.requires_owner_confirmation, fta.display_order
      FROM master.fabric_type_attributes fta JOIN master.product_attribute_definitions d ON d.attribute_id = fta.attribute_id
      WHERE fta.fabric_type_id = $1 AND fta.is_active ORDER BY fta.display_order, d.label`, [productId]),
  ]);
  return { ...product, fabric_type_id: String(product.fabric_type_id), colours: colours.rows.map((row) => ({ ...row, colour_id: String(row.colour_id) })), bom: bom.rows.map((row) => ({ ...row, yarn_type_id: String(row.yarn_type_id), kg_per_meter: Number(row.kg_per_meter), wastage_percent: Number(row.wastage_percent) })), attributes: attributes.rows };
}
async function ownerTransaction(userId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, TRUE)", [String(userId)]);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new AppError(409, 'CATALOG_CONFLICT', 'A product with this SKU or title already exists.');
    if (error.code === '23503') throw new AppError(400, 'INVALID_REFERENCE', 'One or more selected catalogue references are invalid.');
    throw error;
  } finally { client.release(); }
}
const productFields = new Set(['fabric_code', 'fabric_name', 'product_description', 'image_url', 'product_category', 'weave', 'gsm', 'width_inch', 'hsn_code', 'default_rate_per_meter', 'default_tax_percent', 'estimated_cost_per_meter', 'minimum_order_quantity', 'order_unit_code', 'lead_time_days']);
async function createProduct(userId, product) {
  return ownerTransaction(userId, async (client) => {
    const fields = Object.keys(product).filter((key) => productFields.has(key));
    const columns = [...fields, 'is_active', 'is_published'];
    const values = [...fields.map((key) => product[key]), true, false];
    const sql = `INSERT INTO master.fabric_types (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING fabric_type_id, fabric_code, fabric_name, is_published`;
    return (await client.query(sql, values)).rows[0];
  });
}
async function updateProduct(userId, productId, product) {
  parseId(productId);
  const fields = Object.keys(product).filter((key) => productFields.has(key));
  if (!fields.length) throw new AppError(400, 'EMPTY_UPDATE', 'Provide at least one product field to update.');
  return ownerTransaction(userId, async (client) => {
    const assignments = fields.map((key, index) => `${key} = $${index + 2}`);
    const result = await client.query(`UPDATE master.fabric_types SET ${assignments.join(', ')} WHERE fabric_type_id = $1 RETURNING fabric_type_id, fabric_code, fabric_name, is_published`, [productId, ...fields.map((key) => product[key])]);
    if (!result.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
    return result.rows[0];
  });
}
async function setProductState(userId, productId, field, value) {
  parseId(productId);
  if (!['is_published', 'is_active'].includes(field)) throw new Error('Invalid product state field');
  return ownerTransaction(userId, async (client) => {
    const result = await client.query(`UPDATE master.fabric_types SET ${field} = $2 WHERE fabric_type_id = $1 RETURNING fabric_type_id, fabric_code, fabric_name, is_published, is_active`, [productId, value]);
    if (!result.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
    return result.rows[0];
  });
}
async function replaceColours(userId, productId, colours) {
  parseId(productId);
  return ownerTransaction(userId, async (client) => {
    const product = await client.query('SELECT 1 FROM master.fabric_types WHERE fabric_type_id = $1 FOR UPDATE', [productId]);
    if (!product.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
    const ids = colours.map((item) => item.colourId);
    const existing = await client.query('SELECT colour_id FROM master.colours WHERE colour_id = ANY($1::bigint[]) AND is_active', [ids]);
    if (existing.rowCount !== ids.length) throw new AppError(400, 'INVALID_COLOUR', 'Choose only active colours.');
    await client.query('DELETE FROM master.fabric_type_colours WHERE fabric_type_id = $1', [productId]);
    for (const colour of colours) await client.query('INSERT INTO master.fabric_type_colours(fabric_type_id, colour_id, is_default, is_active) VALUES ($1,$2,$3,true)', [productId, colour.colourId, colour.isDefault]);
    return { count: colours.length };
  });
}
async function replaceBom(userId, productId, lines) {
  parseId(productId);
  return ownerTransaction(userId, async (client) => {
    const product = await client.query('SELECT 1 FROM master.fabric_types WHERE fabric_type_id = $1 FOR UPDATE', [productId]);
    if (!product.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
    const ids = lines.map((line) => line.yarnTypeId);
    const active = await client.query('SELECT yarn_type_id FROM master.yarn_types WHERE yarn_type_id = ANY($1::bigint[]) AND is_active', [ids]);
    if (active.rowCount !== ids.length) throw new AppError(400, 'INVALID_YARN', 'Choose only active yarn types.');
    await client.query('DELETE FROM master.fabric_bom WHERE fabric_type_id = $1', [productId]);
    for (const line of lines) await client.query('INSERT INTO master.fabric_bom(fabric_type_id,yarn_type_id,kg_per_meter,wastage_percent) VALUES ($1,$2,$3,$4)', [productId, line.yarnTypeId, line.kgPerMeter, line.wastagePercent]);
    return { count: lines.length };
  });
}
async function replaceAttributes(userId, productId, attributes) {
  parseId(productId);
  return ownerTransaction(userId, async (client) => {
    const product = await client.query('SELECT 1 FROM master.fabric_types WHERE fabric_type_id = $1 FOR UPDATE', [productId]);
    if (!product.rowCount) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product was not found.');
    const codes = attributes.map((item) => item.attributeCode);
    const definitions = await client.query('SELECT attribute_id, attribute_code, data_type FROM master.product_attribute_definitions WHERE attribute_code = ANY($1::text[]) AND is_active', [codes]);
    if (definitions.rowCount !== codes.length) throw new AppError(400, 'INVALID_ATTRIBUTE', 'One or more attribute definitions are missing or inactive.');
    const byCode = new Map(definitions.rows.map((row) => [row.attribute_code, row]));
    await client.query('DELETE FROM master.fabric_type_attributes WHERE fabric_type_id = $1', [productId]);
    for (const item of attributes) {
      const def = byCode.get(item.attributeCode);
      const valueColumns = { default_value_text: null, default_value_numeric: null, default_value_boolean: null };
      if (item.defaultValue !== null) {
        if (['TEXT', 'SELECT'].includes(def.data_type)) valueColumns.default_value_text = item.defaultValue;
        else if (def.data_type === 'NUMBER') {
          const parsed = Number(item.defaultValue); if (!Number.isFinite(parsed)) throw new AppError(400, 'INVALID_ATTRIBUTE', `${item.attributeCode} needs a numeric default.`);
          valueColumns.default_value_numeric = parsed;
        } else if (def.data_type === 'BOOLEAN') {
          if (!['true', 'false'].includes(item.defaultValue)) throw new AppError(400, 'INVALID_ATTRIBUTE', `${item.attributeCode} needs a true or false default.`);
          valueColumns.default_value_boolean = item.defaultValue === 'true';
        }
      }
      await client.query(`INSERT INTO master.fabric_type_attributes(fabric_type_id,attribute_id,default_value_text,default_value_numeric,default_value_boolean,allowed_values,customer_configurable,required_for_order,minimum_numeric_value,maximum_numeric_value,requires_owner_confirmation,display_order,is_active)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,true)`, [productId, def.attribute_id, valueColumns.default_value_text, valueColumns.default_value_numeric, valueColumns.default_value_boolean, JSON.stringify(item.allowedValues), item.customerConfigurable, item.requiredForOrder, item.minimumNumericValue, item.maximumNumericValue, item.requiresOwnerConfirmation, item.displayOrder]);
    }
    return { count: attributes.length };
  });
}
async function listColours() {
  const result = await pool.query('SELECT colour_id, colour_name, hex_code FROM master.colours WHERE is_active ORDER BY colour_name');
  return result.rows.map((row) => ({ ...row, colour_id: String(row.colour_id) }));
}
async function listYarns() {
  const result = await pool.query('SELECT yarn_type_id, yarn_code, yarn_name, material FROM master.yarn_types WHERE is_active ORDER BY yarn_name');
  return result.rows.map((row) => ({ ...row, yarn_type_id: String(row.yarn_type_id) }));
}
async function listDefinitions() {
  const result = await pool.query('SELECT attribute_code, label, data_type, unit_code, description FROM master.product_attribute_definitions WHERE is_active ORDER BY label');
  return result.rows;
}

module.exports = { listPublic, getPublic, listOwner, getOwner, createProduct, updateProduct, setProductState, replaceColours, replaceBom, replaceAttributes, listColours, listYarns, listDefinitions };

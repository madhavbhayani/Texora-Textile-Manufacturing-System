'use strict';

const AppError = require('../../../shared/errors/AppError');
const fail = (message) => { throw new AppError(400, 'VALIDATION_ERROR', message); };
const text = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
};
const number = (value, label, min, max = Number.MAX_SAFE_INTEGER) => {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) fail(`${label} must be a valid number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) fail(`${label} must be between ${min} and ${max}.`);
  return parsed;
};
const optionalNumber = (value, label, min, max) => value == null || value === '' ? null : number(value, label, min, max);

function validateProduct(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('A product object is required.');
  const value = {};
  const fields = {
    fabric_code: (v) => text(v, 'SKU', 60).toUpperCase(),
    fabric_name: (v) => text(v, 'Product title', 180),
    product_description: (v) => v == null ? null : text(v, 'Description', 2000),
    image_url: (v) => {
      if (v == null || v === '') return null;
      const result = text(v, 'Image URL', 2048);
      let url; try { url = new URL(result); } catch { fail('Image URL must use HTTP or HTTPS.'); }
      if (!['http:', 'https:'].includes(url.protocol)) fail('Image URL must use HTTP or HTTPS.');
      return url.toString();
    },
    product_category: (v) => text(v, 'Category', 80).toUpperCase(),
    weave: (v) => v == null ? null : text(v, 'Weave', 80),
    gsm: (v) => { const parsed = optionalNumber(v, 'GSM', 1, 10000); if (parsed != null && !Number.isInteger(parsed)) fail('GSM must be a whole number.'); return parsed; },
    width_inch: (v) => optionalNumber(v, 'Width', 0.01, 1000),
    hsn_code: (v) => v == null ? null : text(v, 'HSN code', 30),
    default_rate_per_meter: (v) => number(v, 'Selling rate', 0, 9999999999),
    default_tax_percent: (v) => number(v, 'Tax percentage', 0, 100),
    estimated_cost_per_meter: (v) => number(v, 'Estimated cost', 0, 9999999999),
    minimum_order_quantity: (v) => number(v, 'Minimum order quantity', 0.01, 9999999999),
    order_unit_code: (v) => { const unit = text(v, 'Order unit', 10).toUpperCase(); if (unit !== 'MTR') fail('Customer orders currently support MTR only.'); return unit; },
    lead_time_days: (v) => { const parsed = number(v, 'Lead time', 0, 3650); if (!Number.isInteger(parsed)) fail('Lead time must be a whole number of days.'); return parsed; },
  };
  for (const [key, convert] of Object.entries(fields)) {
    if (Object.hasOwn(input, key)) value[key] = convert(input[key]);
    else if (!partial && ['fabric_code', 'fabric_name', 'default_rate_per_meter', 'default_tax_percent', 'estimated_cost_per_meter', 'minimum_order_quantity', 'order_unit_code', 'lead_time_days', 'product_category'].includes(key)) fail(`${key} is required.`);
  }
  if (!partial) { value.is_active = true; value.is_published = false; }
  return value;
}

function validateBom(input) {
  if (!Array.isArray(input) || !input.length || input.length > 50) fail('BOM must contain between 1 and 50 yarn lines.');
  const seen = new Set();
  return input.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail('Each BOM line must be an object.');
    const yarnTypeId = number(line.yarnTypeId, 'Yarn type ID', 1);
    if (seen.has(yarnTypeId)) fail('Each yarn type may appear once in the BOM.');
    seen.add(yarnTypeId);
    return { yarnTypeId, kgPerMeter: number(line.kgPerMeter, 'Kg per metre', 0.00001, 99999.99999), wastagePercent: number(line.wastagePercent ?? 0, 'Wastage percentage', 0, 100) };
  });
}

function validateColours(input) {
  if (!Array.isArray(input) || !input.length || input.length > 100) fail('Select at least one available colour.');
  if (input.some((entry) => entry == null || (typeof entry !== 'number' && typeof entry !== 'string' && (typeof entry !== 'object' || Array.isArray(entry))))) fail('Each colour selection must include a colour ID.');
  const ids = input.map((entry) => typeof entry === 'object' ? entry.colourId : entry);
  const unique = new Set(ids.map((id) => number(id, 'Colour ID', 1)));
  if (unique.size !== ids.length) fail('Colour IDs must be unique.');
  const defaults = input.filter((entry) => typeof entry === 'object' && entry.isDefault);
  if (defaults.length > 1) fail('Only one colour may be the default.');
  return ids.map((colourId, index) => ({ colourId: Number(colourId), isDefault: typeof input[index] === 'object' && Boolean(input[index].isDefault) }));
}

function validateAttributes(input) {
  if (!Array.isArray(input) || input.length > 100) fail('Attributes must be a list of at most 100 entries.');
  const seen = new Set();
  const attributes = input.map((item) => ({
    attributeCode: (() => { if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Each attribute must be an object.'); const code = text(item.attributeCode, 'Attribute code', 60).toUpperCase(); if (seen.has(code)) fail('Attribute codes must be unique.'); seen.add(code); return code; })(),
    defaultValue: item.defaultValue == null ? null : String(item.defaultValue),
    allowedValues: (() => { const values = item.allowedValues ?? []; if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 120) || values.length > 100 || new Set(values).size !== values.length) fail('Allowed options must be unique text values.'); return values; })(),
    customerConfigurable: Boolean(item.customerConfigurable), requiredForOrder: Boolean(item.requiredForOrder),
    minimumNumericValue: optionalNumber(item.minimumNumericValue, 'Minimum attribute value', -1e12, 1e12),
    maximumNumericValue: optionalNumber(item.maximumNumericValue, 'Maximum attribute value', -1e12, 1e12),
    requiresOwnerConfirmation: Boolean(item.requiresOwnerConfirmation), displayOrder: number(item.displayOrder ?? 0, 'Display order', 0, 10000),
  }));
  if (attributes.some((item) => item.minimumNumericValue != null && item.maximumNumericValue != null && item.minimumNumericValue > item.maximumNumericValue)) fail('Attribute minimum values cannot exceed maximum values.');
  return attributes;
}

module.exports = { validateProduct, validateBom, validateColours, validateAttributes };

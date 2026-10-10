'use strict';

const AppError = require('../../../shared/errors/AppError');
const bad = (message) => { throw new AppError(400, 'VALIDATION_ERROR', message); };
function positiveId(value, label) {
  if (!/^[1-9]\d*$/.test(String(value))) bad(`${label} must be a valid ID.`);
  return String(value);
}
function validateOrder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('An order object is required.');
  const shippingAddressId = positiveId(input.shippingAddressId, 'Shipping address');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) bad('An order must contain between 1 and 50 products.');
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) bad('Each order item must be an object.');
    const attributes = item.attributes ?? [];
    if (!Array.isArray(attributes) || attributes.length > 50) bad('Product attributes must be a list.');
    return {
      productId: positiveId(item.productId, 'Product'), colourId: positiveId(item.colourId, 'Colour'),
      quantityMeters: typeof item.quantityMeters === 'boolean' || (typeof item.quantityMeters === 'string' && !item.quantityMeters.trim()) ? NaN : Number(item.quantityMeters),
      attributes: attributes.map((attribute) => {
        if (!attribute || typeof attribute !== 'object' || Array.isArray(attribute)) bad('Each product attribute must be an object.');
        if (!attribute || typeof attribute.attributeCode !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(attribute.attributeCode)) bad('An attribute code is invalid.');
        if (typeof attribute.value !== 'string' && typeof attribute.value !== 'number' && typeof attribute.value !== 'boolean') bad('Attribute values must be text, numbers or booleans.');
        const value = String(attribute.value);
        if (!value.trim() || value.length > 500) bad('Attribute values must contain 1 to 500 characters.');
        return { attributeCode: attribute.attributeCode.toUpperCase(), value: value.trim() };
      }),
    };
  });
  for (const item of items) if (!Number.isFinite(item.quantityMeters) || item.quantityMeters <= 0 || item.quantityMeters > 9999999999) bad('Each order quantity must be positive and valid.');
  if (new Set(items.map((item) => `${item.productId}:${item.colourId}`)).size !== items.length) bad('Combine duplicate product and colour lines into one quantity.');
  if (input.requiredByDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(input.requiredByDate)) bad('Required delivery date must use YYYY-MM-DD.');
  return { shippingAddressId, items, requiredByDate: input.requiredByDate || null };
}
function validateAddress(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('An address object is required.');
  if (input.isDefault != null && typeof input.isDefault !== 'boolean') bad('isDefault must be true or false.');
  const required = ['line1', 'city', 'state', 'pincode', 'country'];
  const address = {};
  for (const key of required) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || value.trim().length > (key === 'line1' ? 200 : 100)) bad(`${key} is required and must be within the allowed length.`);
    address[key] = value.trim();
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(address.pincode)) bad('Enter a valid postal or ZIP code.');
  if (input.line2 != null && (typeof input.line2 !== 'string' || input.line2.trim().length > 200)) bad('Address line 2 must be at most 200 characters.');
  if (input.label != null && (typeof input.label !== 'string' || input.label.trim().length > 60)) bad('Address label must be at most 60 characters.');
  return { ...address, line2: input.line2?.trim() || null, label: input.label?.trim() || null, isDefault: Boolean(input.isDefault) };
}
function validateAddressId(value) { return positiveId(value, 'Address'); }
module.exports = { validateOrder, validateAddress, validateAddressId };

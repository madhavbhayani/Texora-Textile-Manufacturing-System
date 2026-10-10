'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateProduct, validateBom, validateColours, validateAttributes } = require('../modules/orders/validators/productValidator');
const { validateOrder, validateAddress } = require('../modules/orders/validators/orderValidator');

describe('catalogue write validation', () => {
  const validProduct = { fabric_code: 'FAB-ONE', fabric_name: 'Plain Cotton', product_category: 'COTTON', default_rate_per_meter: 100, default_tax_percent: 5, estimated_cost_per_meter: 70, minimum_order_quantity: 50, order_unit_code: 'MTR', lead_time_days: 14 };

  it('normalizes product details and always creates drafts without trusting client state', () => {
    const product = validateProduct({ ...validProduct, fabric_code: ' fab-one ', image_url: 'https://example.test/fabric.jpg', is_active: false, is_published: true, estimated_cost_per_meter: 70 });
    assert.equal(product.fabric_code, 'FAB-ONE');
    assert.equal(product.is_published, false);
    assert.equal(product.is_active, true);
    assert.equal(Object.hasOwn(product, 'catalog_created_by'), false);
  });

  it('rejects unsafe URLs and negative selling or manufacturing amounts', () => {
    assert.throws(() => validateProduct({ ...validProduct, image_url: 'data:text/html,hello' }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateProduct({ ...validProduct, default_rate_per_meter: -1 }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateProduct({ ...validProduct, estimated_cost_per_meter: -1 }), { code: 'VALIDATION_ERROR' });
  });

  it('checks BOM, colour and typed attribute payload shape', () => {
    assert.deepEqual(validateBom([{ yarnTypeId: 2, kgPerMeter: 0.2, wastagePercent: 5 }]), [{ yarnTypeId: 2, kgPerMeter: 0.2, wastagePercent: 5 }]);
    assert.throws(() => validateBom([{ yarnTypeId: 2, kgPerMeter: 0 }]), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateColours([{ colourId: 1, isDefault: true }, { colourId: 1 }]), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateAttributes([{ attributeCode: 'FINISH', allowedValues: ['A', 'A'] }]), { code: 'VALIDATION_ERROR' });
  });
});

describe('customer order request validation', () => {
  it('accepts valid line selections and strips all client-controlled prices, roles and status', () => {
    const order = validateOrder({
      shippingAddressId: 4, buyer_id: 800, status: 'CONFIRMED', requiredByDate: '2026-11-15', total: 1,
      items: [{ productId: 1, colourId: 2, quantityMeters: 250, ratePerMeter: 0, taxPercent: 0, attributes: [{ attributeCode: 'SPECIAL_INSTRUCTIONS', value: 'Please check finish.' }] }],
    });
    assert.deepEqual(order.items[0], { productId: '1', colourId: '2', quantityMeters: 250, attributes: [{ attributeCode: 'SPECIAL_INSTRUCTIONS', value: 'Please check finish.' }] });
    assert.equal(Object.hasOwn(order, 'buyer_id'), false);
    assert.equal(Object.hasOwn(order.items[0], 'ratePerMeter'), false);
  });

  it('rejects invalid IDs, quantities, and oversized instruction values', () => {
    assert.throws(() => validateOrder({ shippingAddressId: 0, items: [{ productId: 1, colourId: 2, quantityMeters: 1 }] }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateOrder({ shippingAddressId: 4, items: [{ productId: 1, colourId: 2, quantityMeters: 0 }] }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateOrder({ shippingAddressId: 4, items: [{ productId: 1, colourId: 2, quantityMeters: 1, attributes: [{ attributeCode: 'SPECIAL_INSTRUCTIONS', value: 'x'.repeat(501) }] }] }), { code: 'VALIDATION_ERROR' });
  });
});

describe('buyer address validation', () => {
  it('normalizes multiple customer supplied delivery address fields', () => {
    assert.deepEqual(validateAddress({ label: '  Main warehouse ', line1: '  12 Mill Road ', line2: '', city: 'Surat', state: 'Gujarat', pincode: '395003', country: 'India', isDefault: true, buyerId: 10 }), {
      label: 'Main warehouse', line1: '12 Mill Road', line2: null, city: 'Surat', state: 'Gujarat', pincode: '395003', country: 'India', isDefault: true,
    });
  });

  it('rejects incomplete address information and malformed postal codes', () => {
    assert.throws(() => validateAddress({ line1: '', city: 'Surat', state: 'Gujarat', pincode: '395003', country: 'India' }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateAddress({ line1: '12 Mill Road', city: 'Surat', state: 'Gujarat', pincode: '!!', country: 'India' }), { code: 'VALIDATION_ERROR' });
  });
});

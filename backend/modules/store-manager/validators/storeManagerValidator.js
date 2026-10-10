'use strict';
const AppError = require('../../../shared/errors/AppError');
const fail = (message) => { throw new AppError(400, 'VALIDATION_ERROR', message); };
function id(value, label = 'ID') { if (!/^[1-9]\d*$/.test(String(value ?? ''))) fail(`${label} must be a valid ID.`); return String(value); }
function page(query = {}) { const limit = Number(query.limit ?? 25); const offset = Number(query.offset ?? 0); if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) fail('Pagination must use a limit from 1 to 100 and a nonnegative offset.'); return { limit, offset }; }
function text(value, label, max = 200, required = true) { if (!required && (value == null || value === '')) return null; if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required and must be at most ${max} characters.`); return value.trim(); }
function positive(value, label, allowZero = false) { const n = Number(value); if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) fail(`${label} must be ${allowZero ? 'nonnegative' : 'positive'}.`); return n; }
function supplier(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Supplier details are required.');
  const email = input.email == null || input.email === '' ? null : text(input.email, 'Email', 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid supplier email.');
  const phone = input.phone == null || input.phone === '' ? null : String(input.phone).replace(/[\s()-]/g, '');
  if (phone && !/^\+?[0-9]{10,15}$/.test(phone)) fail('Enter a valid phone number.');
  const terms = input.paymentTermsDays == null ? 30 : Number(input.paymentTermsDays);
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) fail('Payment terms must be from 0 to 365 days.');
  return { supplierName: text(input.supplierName, 'Supplier name'), contactPerson: text(input.contactPerson, 'Contact person', 120, false), phone, email, gstNo: text(input.gstNo, 'GST number', 30, false), addressLine: text(input.addressLine, 'Address', 250, false), city: text(input.city, 'City', 100, false), state: text(input.state, 'State', 100, false), pincode: text(input.pincode, 'PIN code', 12, false), paymentTermsDays: terms, isActive: input.isActive !== false };
}
function po(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Purchase order details are required.');
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) fail('Add between 1 and 100 purchase order lines.');
  const purchaseType = input.purchaseType;
  if (!['GENERAL', 'ORDER_SPECIFIC'].includes(purchaseType)) fail('Choose a general or order-specific purchase.');
  const items = input.items.map((line) => ({ yarnTypeId: id(line.yarnTypeId, 'Yarn type'), colourId: line.colourId ? id(line.colourId, 'Colour') : null, quantityKg: positive(line.quantityKg, 'Quantity'), unitRate: positive(line.unitRate, 'Unit rate', true), taxPercent: line.taxPercent == null ? 5 : Number(line.taxPercent) }));
  if (items.some((line) => !Number.isFinite(line.taxPercent) || line.taxPercent < 0 || line.taxPercent > 100)) fail('Tax percentage must be from 0 to 100.');
  if (purchaseType === 'ORDER_SPECIFIC' && !input.linkedOrderId) fail('Select the customer order for an order-specific purchase.');
  if (purchaseType === 'GENERAL' && input.linkedOrderId) fail('General purchases cannot be linked to a customer order.');
  return { supplierId: id(input.supplierId, 'Supplier'), purchaseType, linkedOrderId: input.linkedOrderId ? id(input.linkedOrderId, 'Order') : null, expectedDate: input.expectedDate || null, notes: text(input.notes, 'Notes', 1000, false), items };
}
function receive(input) {
  if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail('Receipt must contain one or more purchase order lines.');
  return { deliveryNoteNo: text(input.deliveryNoteNo, 'Delivery note', 100, false), notes: text(input.notes, 'Notes', 1000, false), items: input.items.map((line) => ({ poItemId: id(line.poItemId, 'Purchase order line'), receivedQtyKg: positive(line.receivedQtyKg, 'Received quantity'), acceptedQtyKg: positive(line.acceptedQtyKg, 'Accepted quantity', true), unitCost: positive(line.unitCost, 'Unit cost', true), lotCode: text(line.lotCode, 'Lot code', 100, false) })) };
}
function invoice(input) {
  if (!input || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) fail('Invoice must include one or more received items.');
  return { goodsReceiptId: id(input.goodsReceiptId, 'Goods receipt'), invoiceNo: text(input.invoiceNo, 'Supplier invoice number', 100), invoiceDate: input.invoiceDate || null, dueDate: input.dueDate || null, notes: text(input.notes, 'Notes', 1000, false), items: input.items.map((line) => ({ goodsReceiptItemId: id(line.goodsReceiptItemId, 'Receipt item'), quantityKg: positive(line.quantityKg, 'Billed quantity'), unitRate: positive(line.unitRate, 'Unit rate', true), taxPercent: line.taxPercent == null ? 5 : Number(line.taxPercent) })) };
}
function payment(input) {
  const methods = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'OTHER'];
  if (!input || !methods.includes(input.paymentMethod)) fail('Choose a valid payment method.');
  return { supplierInvoiceId: id(input.supplierInvoiceId, 'Invoice'), amount: positive(input.amount, 'Payment amount'), paymentMethod: input.paymentMethod, paymentDate: input.paymentDate || null, paymentReference: text(input.paymentReference, 'Payment reference', 120, false), notes: text(input.notes, 'Notes', 1000, false) };
}
function handoff(input) {
  if (!input || typeof input !== 'object') fail('Handoff details are required.');
  const stage = input.stage;
  if (!['SPINNING', 'WEAVING', 'DYEING'].includes(stage)) fail('Choose a valid production stage.');
  return { orderItemId: id(input.orderItemId, 'Order item'), supervisorUserId: id(input.supervisorUserId, 'Supervisor'), plannedMeters: positive(input.plannedMeters, 'Planned metres'), stage, notes: text(input.notes, 'Notes', 1000, false) };
}
module.exports = { id, page, text, positive, supplier, po, receive, invoice, payment, handoff };

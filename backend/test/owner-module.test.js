'use strict';

process.env.DATABASE_HOST ||= '127.0.0.1';
process.env.DATABASE_NAME ||= 'texora_test';
process.env.DATABASE_USER ||= 'texora_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../database/config/db');
const service = require('../modules/owner/services/ownerService');
const requirePermission = require('../modules/owner/middleware/requirePermission');

const originalQuery = pool.query.bind(pool);
const originalConnect = pool.connect.bind(pool);
test.afterEach(() => {
  pool.query = originalQuery;
  pool.connect = originalConnect;
});

test('Owner permission middleware verifies the active user permission in PostgreSQL', async () => {
  let values;
  pool.query = async (_sql, args) => { values = args; return { rows: [{ allowed: true }] }; };
  let nextError;
  await requirePermission('finance.view')({ auth: { userId: '8' } }, {}, error => { nextError = error; });
  assert.equal(nextError, undefined);
  assert.deepEqual(values, ['8', 'finance.view']);
});

test('Owner role changes are validated and audit the persisted role change', async () => {
  const calls = [];
  pool.connect = async () => ({
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT user_id,role_id FROM auth.users')) return { rowCount: 1, rows: [{ user_id: '9', role_id: 4 }] };
      if (sql.includes('SELECT role_id FROM auth.roles')) return { rowCount: 1, rows: [{ role_id: 5 }] };
      if (sql.includes('SELECT role_code FROM auth.roles')) return { rowCount: 1, rows: [{ role_code: 'WORKER' }] };
      if (sql.includes('SELECT count(*)::int count FROM auth.users')) return { rowCount: 1, rows: [{ count: 1 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  });
  const result = await service.updateUserRole('2', '9', 'SUPERVISOR');
  assert.deepEqual(result, { user_id: '9', role_code: 'SUPERVISOR' });
  const audit = calls.find(call => call.sql.includes('INSERT INTO audit.change_log'));
  assert.ok(audit);
  assert.match(audit.sql, /VALUES\(\$1,'UPDATE','auth','users'/);
  assert.equal(audit.args[1], '9');
});

test('Owner cannot demote their own account or the final active Owner', async () => {
  await assert.rejects(service.updateUserRole('7', '7', 'BUYER'), error => error.code === 'SELF_ROLE_CHANGE');
  pool.connect = async () => ({
    query: async sql => {
      if (sql.includes('SELECT user_id,role_id FROM auth.users')) return { rowCount: 1, rows: [{ user_id: '7', role_id: 1 }] };
      if (sql.includes('SELECT role_id FROM auth.roles')) return { rowCount: 1, rows: [{ role_id: 2 }] };
      if (sql.includes('SELECT role_code FROM auth.roles')) return { rowCount: 1, rows: [{ role_code: 'OWNER' }] };
      if (sql.includes('SELECT count(*)::int count FROM auth.users')) return { rowCount: 1, rows: [{ count: 0 }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  });
  await assert.rejects(service.updateUserRole('8', '7', 'BUYER'), error => error.code === 'LAST_OWNER');
});

test('Owner settings accept only supported bounded values and record changes', async () => {
  await assert.rejects(service.updateSetting('4', 'unknown_setting', 'value'), error => error.code === 'VALIDATION_ERROR');
  const calls = [];
  pool.connect = async () => ({
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT setting_value,description FROM core.app_settings')) return { rowCount: 1, rows: [{ setting_value: '8', description: 'Shift length' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  });
  const result = await service.updateSetting('4', 'standard_shift_hours', '9');
  assert.equal(result.setting_value, '9');
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO audit.change_log')));
});

test('Supplier payments cannot be recorded with a non-positive amount', async () => {
  await assert.rejects(service.recordSupplierPayment('4', {
    supplierInvoiceId: '1', amount: 0, paymentMethod: 'BANK_TRANSFER',
  }), error => error.code === 'VALIDATION_ERROR');
});

test('Supplier invoice recorder cannot approve their own invoice', async () => {
  const calls = [];
  pool.connect = async () => ({
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT * FROM procurement.supplier_invoices')) return {
        rowCount: 1,
        rows: [{ supplier_invoice_id: '3', status: 'RECORDED', recorded_by: '8' }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  });
  await assert.rejects(service.approveInvoice('8', '3', 'Reviewed against receipt'), error => error.code === 'MAKER_CHECKER_CONFLICT');
  assert.ok(!calls.some(call => call.sql.includes("decision,reason,actor_user_id) VALUES($1,'APPROVED'")));
});

test('Supplier payment cannot be recorded until the invoice is approved', async () => {
  const calls = [];
  pool.connect = async () => ({
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT supplier_invoice_id,status FROM procurement.supplier_invoices')) return {
        rowCount: 1,
        rows: [{ supplier_invoice_id: '5', status: 'RECORDED' }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  });
  await assert.rejects(service.recordSupplierPayment('4', {
    supplierInvoiceId: '5', amount: 100, paymentMethod: 'BANK_TRANSFER',
  }), error => error.code === 'INVOICE_NOT_APPROVED');
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO procurement.supplier_payments')));
});

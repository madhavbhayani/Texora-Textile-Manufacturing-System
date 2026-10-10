'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const validator = require('../modules/store-manager/validators/storeManagerValidator');
const authorize = require('../modules/auth/middleware/authorize');

test('Store Manager supplier validation normalizes and limits contact data', () => {
  const supplier = validator.supplier({ supplierName:' Yarn House ', email:'SALES@YARN.EXAMPLE', phone:'+91 98765 43210', paymentTermsDays:'45' });
  assert.equal(supplier.supplierName,'Yarn House');
  assert.equal(supplier.email,'sales@yarn.example');
  assert.equal(supplier.phone,'+919876543210');
  assert.equal(supplier.paymentTermsDays,45);
  assert.throws(()=>validator.supplier({supplierName:'',paymentTermsDays:-1}));
});

test('purchase order validator enforces purchase mode relationships and positive line quantities', () => {
  const draft=validator.po({supplierId:2,purchaseType:'GENERAL',items:[{yarnTypeId:3,quantityKg:10,unitRate:12,taxPercent:5}]});
  assert.equal(draft.linkedOrderId,null);
  assert.throws(()=>validator.po({supplierId:2,purchaseType:'GENERAL',linkedOrderId:9,items:[{yarnTypeId:3,quantityKg:10,unitRate:12}]}));
  assert.throws(()=>validator.po({supplierId:2,purchaseType:'ORDER_SPECIFIC',linkedOrderId:9,items:[{yarnTypeId:3,quantityKg:0,unitRate:12}]}));
});

test('filters validate date ranges and movement type against the ledger', () => {
  assert.deepEqual(validator.filters({from:'2026-10-01',to:'2026-10-10',movementType:'RECEIPT'},'movements'),{from:'2026-10-01',to:'2026-10-10',movementType:'RECEIPT'});
  assert.throws(()=>validator.filters({from:'2026-10-11',to:'2026-10-10'},'lots'));
  assert.throws(()=>validator.filters({movementType:'EDIT_STOCK'},'movements'));
});

test('Store Manager backend routes reject unrelated roles and temporary-password sessions', () => {
  const gate=authorize('STORE_MANAGER','OWNER');
  let error;
  gate({auth:{roleCode:'WORKER'}},{},(value)=>{error=value;});
  assert.equal(error.status,403);
  gate({auth:{roleCode:'STORE_MANAGER',mustChangePassword:true}},{},(value)=>{error=value;});
  assert.equal(error.code,'PASSWORD_CHANGE_REQUIRED');
  let passed=false;
  gate({auth:{roleCode:'STORE_MANAGER',mustChangePassword:false}},{},(value)=>{passed=value===undefined;});
  assert.equal(passed,true);
});

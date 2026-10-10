'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateSignup, validateLogin } = require('../modules/buyers/validators/buyerValidator');
const { signAccessToken, verifyAccessToken } = require('../modules/auth/services/tokenService');
const { hashToken, safeHashEqual } = require('../modules/auth/utils/tokenHash');
const { parseSessionId } = require('../modules/auth/utils/refreshToken');

describe('buyer request validation', () => {
  it('normalizes buyer details and ignores client role and financial fields', () => {
    const value = validateSignup({
      fullName: '  Buyer One ', companyName: '  Mill Co ', email: 'BUYER@EXAMPLE.COM',
      phone: '+91 98765 43210', password: 'a strong password', confirmPassword: 'a strong password',
      role_code: 'OWNER', role_id: 1, credit_limit: 900000, is_active: true,
    });
    assert.deepEqual(value, { fullName: 'Buyer One', companyName: 'Mill Co', email: 'buyer@example.com', phone: '+919876543210', password: 'a strong password' });
    assert.equal(Object.hasOwn(value, 'role_code'), false);
  });

  it('allows an omitted phone and rejects malformed contacts or mismatched confirmation', () => {
    const required = { fullName: 'Buyer One', companyName: 'Mill Co', email: 'buyer@example.com', password: 'a strong password' };
    assert.equal(validateSignup(required).phone, null);
    assert.throws(() => validateSignup({ ...required, phone: '123' }), { code: 'VALIDATION_ERROR' });
    assert.throws(() => validateSignup({ ...required, confirmPassword: 'different' }), { code: 'VALIDATION_ERROR' });
    assert.deepEqual(validateLogin({ email: ' Buyer@Example.com ', password: 'pass' }), { email: 'buyer@example.com', password: 'pass' });
    assert.deepEqual(validateLogin({ email: ' +91 98765 43210 ', password: 'pass' }), { email: '+919876543210', password: 'pass' });
    assert.throws(() => validateLogin({ email: 'not-a-phone', password: 'pass' }), { code: 'VALIDATION_ERROR' });
  });
});

describe('token helpers', () => {
  it('signs and verifies short-lived identity claims without customer secrets', () => {
    process.env.JWT_ACCESS_SECRET = 'unit-test-secret-that-is-long-enough-to-be-safe-123456';
    const token = signAccessToken({ userId: '21', roleCode: 'BUYER', sessionId: '44' });
    assert.deepEqual(verifyAccessToken(token), { userId: '21', roleCode: 'BUYER', sessionId: '44' });
    assert.throws(() => verifyAccessToken(`${token}bad`), { code: 'INVALID_ACCESS_TOKEN' });
  });

  it('hashes opaque tokens and compares their hashes safely', () => {
    const hash = hashToken('refresh-token-example');
    assert.equal(hash.length, 64);
    assert.equal(safeHashEqual(hash, hashToken('refresh-token-example')), true);
    assert.equal(safeHashEqual(hash, hashToken('different-token')), false);
  });

  it('accepts only signed refresh-token session references', () => {
    const { randomBytes, createHmac } = require('node:crypto');
    const secret = process.env.JWT_ACCESS_SECRET;
    const key = createHmac('sha256', secret).update('texora-refresh-token-v1').digest();
    const nonce = randomBytes(32).toString('base64url');
    const payload = `71.${nonce}`;
    const mac = createHmac('sha256', key).update(payload).digest('base64url');
    assert.equal(parseSessionId(`${payload}.${mac}`), '71');
    assert.equal(parseSessionId(`71.${nonce}.invalid-signature`), null);
  });
});

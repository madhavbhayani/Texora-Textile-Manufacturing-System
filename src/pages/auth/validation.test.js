import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateLogin, validateSignup } from './validation.js';

describe('authentication form validation', () => {
  it('requires login email and password and accepts a valid email', () => {
    assert.deepEqual(Object.keys(validateLogin({ email: '', password: '' })).sort(), ['email', 'password']);
    assert.equal(validateLogin({ email: 'buyer@example.com', password: 'secret' }).email, undefined);
    assert.match(validateLogin({ email: 'not-an-email', password: 'secret' }).email, /valid email/i);
  });

  it('accepts customer details and rejects invalid phone, password, and agreement', () => {
    const valid = { company: 'Texora Mills', fullName: 'A Buyer', email: 'buyer@example.com', phone: '+91 98765 43210', password: 'securepass', confirmPassword: 'securepass', agreed: true };
    assert.deepEqual(validateSignup(valid), {});
    assert.deepEqual(Object.keys(validateSignup({ ...valid, company: '', fullName: '', email: '' })).sort(), ['company', 'email', 'fullName']);
    assert.ok(validateSignup({ ...valid, phone: '123' }).phone);
    assert.ok(validateSignup({ ...valid, password: 'short' }).password);
    assert.ok(validateSignup({ ...valid, confirmPassword: 'different' }).confirmPassword);
    assert.ok(validateSignup({ ...valid, agreed: false }).agreed);
  });
});

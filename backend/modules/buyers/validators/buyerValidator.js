'use strict';

const AppError = require('../../../shared/errors/AppError');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(value) {
  if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !emailPattern.test(email)) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid email address.');
  return email;
}
function validatePassword(value) {
  const min = Math.max(8, Number(process.env.PASSWORD_MIN_LENGTH || 8));
  if (typeof value !== 'string' || value.length < min || Buffer.byteLength(value, 'utf8') > 72) {
    throw new AppError(400, 'VALIDATION_ERROR', `Password must be at least ${min} characters and no more than 72 bytes.`);
  }
  return value;
}
function normalizePhone(value, required = false) {
  if (value == null || value === '') {
    if (required) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid phone number.');
    return null;
  }
  if (typeof value !== 'string') throw new AppError(400, 'VALIDATION_ERROR', 'Enter a valid phone number.');
  const phone = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d{10,15}$/.test(phone)) throw new AppError(400, 'VALIDATION_ERROR', 'Phone number must contain 10 to 15 digits, with an optional leading +.');
  return phone;
}
function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'VALIDATION_ERROR', 'A JSON object is required.');
  return body;
}
function validateSignup(body) {
  bodyObject(body);
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
  if (!fullName || fullName.length > 160) throw new AppError(400, 'VALIDATION_ERROR', 'Full name is required and must be 160 characters or fewer.');
  if (!companyName || companyName.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Company name is required and must be 200 characters or fewer.');
  const email = validateEmail(body.email);
  const password = validatePassword(body.password);
  if (body.confirmPassword !== undefined && body.confirmPassword !== password) throw new AppError(400, 'VALIDATION_ERROR', 'Passwords do not match.');
  return { fullName, companyName, email, phone: normalizePhone(body.phone), password };
}
function validateLogin(body) {
  bodyObject(body);
  const email = validateEmail(body.email);
  if (typeof body.password !== 'string' || !body.password || Buffer.byteLength(body.password, 'utf8') > 72) throw new AppError(400, 'VALIDATION_ERROR', 'Email and password are required.');
  return { email, password: body.password };
}
module.exports = { validateSignup, validateLogin, validateEmail, normalizePhone };

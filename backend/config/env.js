'use strict';

const AppError = require('../shared/errors/AppError');

function validateEnvironment() {
  const hasUrl = Boolean(process.env.DATABASE_URL);
  const hasDatabaseParts = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'].some((name) => process.env[name] !== undefined);
  const hasParts = Boolean(process.env.DATABASE_HOST && process.env.DATABASE_NAME && process.env.DATABASE_USER);
  if ((hasUrl && hasDatabaseParts) || (!hasUrl && !hasParts)) throw new Error('Set either DATABASE_URL or DATABASE_HOST, DATABASE_NAME, and DATABASE_USER. Do not configure both forms.');
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Set JWT_ACCESS_SECRET to a random secret of at least 32 bytes.');
  const sameSite = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) throw new Error('COOKIE_SAME_SITE must be lax, strict, or none.');
  if (process.env.COOKIE_SECURE !== undefined && !['true', 'false'].includes(process.env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE must be true or false.');
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  if (sameSite === 'none' && !secure) throw new Error('COOKIE_SECURE=true is required when COOKIE_SAME_SITE=none.');
  const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean).map((origin) => {
    if (origin === '*' || !/^https?:\/\//i.test(origin)) throw new Error('CORS_ORIGIN must contain explicit http(s) origins without paths.');
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) throw new Error('CORS_ORIGIN entries must be exact origins without credentials or paths.');
    return parsed.origin;
  });
  if (!origins.length) throw new Error('CORS_ORIGIN must contain at least one explicit frontend origin.');
  const numeric = {
    PORT: [process.env.PORT, 5000, 1, 65535],
    PASSWORD_MIN_LENGTH: [process.env.PASSWORD_MIN_LENGTH, 8, 8, 72],
    BCRYPT_ROUNDS: [process.env.BCRYPT_ROUNDS, 12, 10, 14],
    LOGIN_MAX_ATTEMPTS: [process.env.LOGIN_MAX_ATTEMPTS, 5, 3, 20],
    LOGIN_LOCK_MINUTES: [process.env.LOGIN_LOCK_MINUTES, 15, 1, 1440],
    REFRESH_TOKEN_EXPIRES_DAYS: [process.env.REFRESH_TOKEN_EXPIRES_DAYS, 7, 1, 90],
    AUTH_RATE_LIMIT: [process.env.AUTH_RATE_LIMIT, 20, 1, 10000],
    AUTH_RATE_WINDOW_MS: [process.env.AUTH_RATE_WINDOW_MS, 900000, 1000, 86400000],
    DATABASE_POOL_MAX: [process.env.DATABASE_POOL_MAX, 10, 2, 100],
    DATABASE_CONNECTION_TIMEOUT_MS: [process.env.DATABASE_CONNECTION_TIMEOUT_MS, 5000, 100, 120000],
    DATABASE_IDLE_TIMEOUT_MS: [process.env.DATABASE_IDLE_TIMEOUT_MS, 30000, 1000, 600000],
  };
  const values = {};
  for (const [name, [raw, fallback, min, max]] of Object.entries(numeric)) {
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    values[name] = value;
  }
  const expiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
  if (!/^(\d+[smhd]|\d+)$/i.test(expiresIn)) throw new Error('JWT_ACCESS_EXPIRES_IN must be a duration such as 15m.');
  for (const name of ['DATABASE_SSL', 'DATABASE_SSL_REJECT_UNAUTHORIZED', 'TRUST_PROXY']) {
    if (process.env[name] !== undefined && !['true', 'false'].includes(process.env[name])) throw new Error(`${name} must be true or false.`);
  }
  if (process.env.DATABASE_PORT !== undefined && (!/^\d+$/.test(process.env.DATABASE_PORT) || Number(process.env.DATABASE_PORT) < 1 || Number(process.env.DATABASE_PORT) > 65535)) throw new Error('DATABASE_PORT must be between 1 and 65535.');
  return { origins, port: values.PORT };
}

function corsError() { return new AppError(403, 'CORS_ORIGIN_DENIED', 'This origin is not allowed.'); }
module.exports = { validateEnvironment, corsError };

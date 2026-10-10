'use strict';

const crypto = require('node:crypto');

function refreshMac(payload) {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes.');
  const key = crypto.createHmac('sha256', secret).update('texora-refresh-token-v1').digest();
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}
function createRefreshToken(sessionId) {
  const payload = `${sessionId}.${crypto.randomBytes(32).toString('base64url')}`;
  return `${payload}.${refreshMac(payload)}`;
}
function parseSessionId(token) {
  const match = typeof token === 'string' && token.match(/^(\d+)\.([A-Za-z0-9_-]{40,})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return null;
  const expected = Buffer.from(refreshMac(`${match[1]}.${match[2]}`));
  const provided = Buffer.from(match[3]);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided) ? match[1] : null;
}

module.exports = { createRefreshToken, parseSessionId };

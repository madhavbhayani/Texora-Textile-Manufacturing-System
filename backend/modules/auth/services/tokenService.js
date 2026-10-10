'use strict';

const jwt = require('jsonwebtoken');
const AppError = require('../../../shared/errors/AppError');

const algorithm = 'HS256';
function secret() {
  const value = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes.');
  return value;
}
function signAccessToken({ userId, roleCode, sessionId }) {
  return jwt.sign({ role: roleCode, sid: String(sessionId) }, secret(), {
    algorithm,
    subject: String(userId),
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    issuer: 'texora-api',
    audience: 'texora-client',
  });
}
function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, secret(), { algorithms: [algorithm], issuer: 'texora-api', audience: 'texora-client' });
    if (!payload.sub || !payload.role || !payload.sid) throw new Error('Required token claims are missing.');
    return { userId: payload.sub, roleCode: payload.role, sessionId: payload.sid };
  } catch {
    throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'A valid access token is required.');
  }
}

module.exports = { signAccessToken, verifyAccessToken };

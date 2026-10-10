'use strict';

const crypto = require('node:crypto');
exports.hashToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
exports.safeHashEqual = (left, right) => {
  const a = Buffer.from(left || '', 'hex');
  const b = Buffer.from(right || '', 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};

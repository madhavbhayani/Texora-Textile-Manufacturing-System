'use strict';

const AppError = require('../../../shared/errors/AppError');
const { verifyAccessToken } = require('../services/tokenService');
const { pool } = require('../../../database/config/db');

module.exports = async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return next(new AppError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.'));
  try {
    const identity = verifyAccessToken(match[1]);
    const result = await pool.query(
      `SELECT u.user_id, u.must_change_password, r.role_code FROM auth.sessions s
       JOIN auth.users u ON u.user_id = s.user_id JOIN auth.roles r ON r.role_id = u.role_id
       LEFT JOIN master.buyers b ON b.user_id = u.user_id
       WHERE s.session_id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > NOW()
         AND u.is_active AND r.is_active AND (r.role_code <> 'BUYER' OR b.is_active)`, [identity.sessionId, identity.userId],
    );
    if (!result.rowCount || result.rows[0].role_code !== identity.roleCode) throw new AppError(401, 'INVALID_ACCESS_TOKEN', 'A valid access token is required.');
    req.auth = { ...identity, mustChangePassword: result.rows[0].must_change_password };
    next();
  }
  catch (error) { next(error); }
};

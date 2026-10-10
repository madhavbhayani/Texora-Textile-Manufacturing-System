'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../services/tokenService');
const { rotateRefreshToken, revokeSession } = require('../services/sessionService');

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production',
  sameSite: process.env.COOKIE_SAME_SITE || 'lax',
  path: '/api/auth',
  maxAge: Math.max(1, Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7)) * 24 * 60 * 60 * 1000,
});
const csrfCookieOptions = () => ({ ...cookieOptions(), httpOnly: false, path: '/' });
function setCredentials(res, session, accessToken) {
  const csrfToken = require('node:crypto').randomBytes(32).toString('base64url');
  res.cookie('texora_refresh', session.refreshToken, cookieOptions());
  res.cookie('texora_csrf', csrfToken, csrfCookieOptions());
  return { accessToken, csrfToken };
}
function csrf(req, res) {
  const csrfToken = require('node:crypto').randomBytes(32).toString('base64url');
  res.cookie('texora_csrf', csrfToken, csrfCookieOptions());
  res.json({ success: true, data: { csrfToken } });
}
function clearCredentials(res) {
  const refreshOptions = cookieOptions();
  const csrfOptions = csrfCookieOptions();
  delete refreshOptions.maxAge;
  delete csrfOptions.maxAge;
  res.clearCookie('texora_refresh', refreshOptions);
  res.clearCookie('texora_csrf', csrfOptions);
}
function verifyCsrf(req) {
  const cookieToken = req.cookies?.texora_csrf;
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) throw new AppError(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed.');
}

async function me(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.phone, u.is_email_verified, u.is_phone_verified,
              r.role_code, b.company_name, u.must_change_password
       FROM auth.users u JOIN auth.roles r ON r.role_id = u.role_id
       LEFT JOIN master.buyers b ON b.user_id = u.user_id
       WHERE u.user_id = $1 AND u.is_active AND r.is_active`, [req.auth.userId],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(401, 'INACTIVE_ACCOUNT', 'This account is no longer active.');
    res.json({ success: true, data: { user: { userId: String(user.user_id), fullName: user.full_name, email: user.email, phone: user.phone, role: user.role_code, companyName: user.company_name, mustChangePassword: user.must_change_password, isEmailVerified: user.is_email_verified, isPhoneVerified: user.is_phone_verified } } });
  } catch (error) { next(error); }
}

async function refresh(req, res, next) {
  try {
    verifyCsrf(req);
    const session = await rotateRefreshToken(req.cookies?.texora_refresh);
    const accessToken = signAccessToken({ userId: session.userId, roleCode: session.roleCode, sessionId: session.sessionId });
    const credentials = setCredentials(res, session, accessToken);
    res.json({ success: true, data: { user: session.user, ...credentials } });
  } catch (error) { next(error); }
}

async function logout(req, res, next) {
  try {
    verifyCsrf(req);
    const refreshToken = req.cookies?.texora_refresh;
    if (refreshToken && !await revokeSession(refreshToken)) throw new AppError(401, 'SESSION_NOT_REVOKED', 'The refresh session could not be revoked.');
    clearCredentials(res);
    res.json({ success: true, message: 'Signed out successfully.' });
  } catch (error) { next(error); }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 72 || newPassword !== confirmPassword) {
      throw new AppError(400, 'INVALID_PASSWORD_CHANGE', 'Enter a matching new password of at least 12 characters.');
    }
    const result = await pool.query('SELECT password_hash FROM auth.users WHERE user_id = $1 AND is_active', [req.auth.userId]);
    if (!result.rowCount) throw new AppError(401, 'INACTIVE_ACCOUNT', 'This account is no longer active.');
    if (!req.auth.mustChangePassword && (typeof currentPassword !== 'string' || !await bcrypt.compare(currentPassword, result.rows[0].password_hash))) throw new AppError(400, 'CURRENT_PASSWORD_INVALID', 'Current password is incorrect.');
    const passwordHash = await bcrypt.hash(newPassword, Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12))));
    await pool.query('UPDATE auth.users SET password_hash = $2, must_change_password = false, password_changed_at = now(), failed_login_attempts = 0, locked_until = NULL WHERE user_id = $1', [req.auth.userId, passwordHash]);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (error) { next(error); }
}

module.exports = { me, refresh, logout, csrf, changePassword, setCredentials, clearCredentials };

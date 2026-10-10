'use strict';

const { pool } = require('../../../database/config/db');
const { hashToken, safeHashEqual } = require('../utils/tokenHash');
const { createRefreshToken, parseSessionId } = require('../utils/refreshToken');
const AppError = require('../../../shared/errors/AppError');

const refreshDays = () => Math.max(1, Math.min(Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS || 7), 90));

async function createSession({ userId, ipAddress, userAgent }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idResult = await client.query("SELECT nextval(pg_get_serial_sequence('auth.sessions', 'session_id')) AS session_id");
    const sessionId = String(idResult.rows[0].session_id);
    const refreshToken = createRefreshToken(sessionId);
    const result = await client.query(
      `INSERT INTO auth.sessions (session_id, user_id, refresh_token_hash, ip_address, user_agent, expires_at)
       OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, $3, $4::inet, $5, NOW() + ($6::text || ' days')::interval)
       RETURNING session_id, expires_at`,
      [sessionId, userId, hashToken(refreshToken), ipAddress || null, userAgent || null, String(refreshDays())],
    );
    await client.query('COMMIT');
    return { sessionId: String(result.rows[0].session_id), expiresAt: result.rows[0].expires_at, refreshToken };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function rotateRefreshToken(refreshToken) {
  const sessionId = parseSessionId(refreshToken);
  if (!sessionId) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh session is required.');
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await client.query(
      `SELECT s.session_id, s.user_id, s.refresh_token_hash, s.expires_at, s.revoked_at,
              u.is_active, r.role_code, r.is_active AS role_active, b.is_active AS buyer_active,
              u.full_name, u.email, u.must_change_password, b.company_name
       FROM auth.sessions s JOIN auth.users u ON u.user_id = s.user_id
       JOIN auth.roles r ON r.role_id = u.role_id
       LEFT JOIN master.buyers b ON b.user_id = u.user_id
       WHERE s.session_id = $1 FOR UPDATE OF s, u`, [sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'A valid refresh session is required.');
    if (!safeHashEqual(row.refresh_token_hash, hashToken(refreshToken))) {
      await client.query('UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE session_id = $1', [sessionId]);
      await client.query('COMMIT');
      transactionOpen = false;
      throw new AppError(401, 'REFRESH_TOKEN_REUSE', 'This refresh session has been revoked. Please sign in again.');
    } else if (row.revoked_at || new Date(row.expires_at) <= new Date() || !row.is_active || !row.role_active || (row.role_code === 'BUYER' && !row.buyer_active)) {
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'This refresh session is no longer valid.');
    } else {
      const nextToken = createRefreshToken(sessionId);
      const updated = await client.query(
        `UPDATE auth.sessions SET refresh_token_hash = $2, last_used_at = NOW(), expires_at = NOW() + ($3::text || ' days')::interval
         WHERE session_id = $1 RETURNING expires_at`,
        [sessionId, hashToken(nextToken), String(refreshDays())],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { sessionId, userId: String(row.user_id), roleCode: row.role_code, user: { userId: String(row.user_id), fullName: row.full_name, email: row.email, role: row.role_code, companyName: row.company_name, mustChangePassword: Boolean(row.must_change_password) }, expiresAt: updated.rows[0].expires_at, refreshToken: nextToken };
    }
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function revokeSession(refreshToken) {
  const sessionId = parseSessionId(refreshToken);
  if (!sessionId) return false;
  const result = await pool.query('UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE session_id = $1 RETURNING session_id', [sessionId]);
  return result.rowCount > 0;
}

async function revokeAllSessions(userId) {
  const result = await pool.query('UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return result.rowCount;
}

module.exports = { createSession, rotateRefreshToken, revokeSession, revokeAllSessions, parseSessionId };

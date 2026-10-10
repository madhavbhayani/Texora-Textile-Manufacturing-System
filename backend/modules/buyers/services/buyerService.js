'use strict';

const bcrypt = require('bcryptjs');
const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');
const { createSession } = require('../../auth/services/sessionService');
const { signAccessToken } = require('../../auth/services/tokenService');

const dummyHashPromise = bcrypt.hash('texora-timing-only-value', 10);
const rounds = () => Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12)));
const maxAttempts = () => Math.min(20, Math.max(3, Number(process.env.LOGIN_MAX_ATTEMPTS || 5)));
const lockMinutes = () => Math.min(1440, Math.max(1, Number(process.env.LOGIN_LOCK_MINUTES || 15)));
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
const publicUser = (row) => ({ userId: String(row.user_id), fullName: row.full_name, email: row.email, role: row.role_code || 'BUYER', companyName: row.company_name || null, mustChangePassword: Boolean(row.must_change_password) });
const requestMetadata = (req) => ({ ipAddress: req.ip || null, userAgent: (req.get('user-agent') || '').slice(0, 1000) || null });

async function signup(input, req) {
  const role = await pool.query("SELECT role_id FROM auth.roles WHERE role_code = 'BUYER' AND is_active");
  if (!role.rowCount) throw new AppError(503, 'BUYER_ROLE_UNAVAILABLE', 'Customer registration is temporarily unavailable.');
  const passwordHash = await bcrypt.hash(input.password, rounds());
  const client = await pool.connect();
  let createdUser;
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `INSERT INTO auth.users (role_id, full_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING user_id, full_name, email`,
      [role.rows[0].role_id, input.fullName, input.email, input.phone, passwordHash],
    );
    createdUser = userResult.rows[0];
    const buyerResult = await client.query(
      `INSERT INTO master.buyers (user_id, company_name)
       VALUES ($1, $2)
       RETURNING company_name`, [createdUser.user_id, input.companyName],
    );
    await client.query('COMMIT');
    createdUser.company_name = buyerResult.rows[0].company_name;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email or phone number already exists.');
    throw error;
  } finally { client.release(); }

  const session = await createSession({ userId: createdUser.user_id, ...requestMetadata(req) });
  const user = publicUser(createdUser);
  return { user, session, accessToken: signAccessToken({ userId: createdUser.user_id, roleCode: 'BUYER', sessionId: session.sessionId }) };
}

async function recordLogin(client, { userId, email, success, failureReason, req }) {
  const meta = requestMetadata(req);
  await client.query(
    `INSERT INTO auth.login_events (user_id, login_identifier, success, failure_reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5::inet, $6)`,
    [userId || null, email, success, failureReason || null, meta.ipAddress, meta.userAgent],
  );
}

async function login(input, req) {
  const client = await pool.connect();
  let user;
  let authenticationFailed = false;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT u.user_id, u.role_id, u.full_name, u.email, u.password_hash, u.is_active, u.must_change_password,
              u.failed_login_attempts, u.locked_until, r.role_code, r.is_active AS role_active,
              b.company_name, b.is_active AS buyer_active
       FROM auth.users u JOIN auth.roles r ON r.role_id = u.role_id
       LEFT JOIN master.buyers b ON b.user_id = u.user_id
       WHERE lower(u.email) = $1 FOR UPDATE OF u`, [input.email],
    );
    user = result.rows[0];
    const isEligibleRole = Boolean(user && user.role_active && (user.role_code !== 'BUYER' || user.buyer_active));
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      await bcrypt.compare(input.password, await dummyHashPromise);
      await recordLogin(client, { userId: user.user_id, email: input.email, success: false, failureReason: 'ACCOUNT_LOCKED', req });
      authenticationFailed = true;
    } else {
      const eligible = Boolean(user && user.is_active && isEligibleRole);
      const hash = eligible ? user.password_hash : await dummyHashPromise;
      const passwordMatches = await bcrypt.compare(input.password, hash);
      if (!eligible || !passwordMatches) {
        if (eligible) {
          const attempts = Number(user.failed_login_attempts) + 1;
          await client.query(
            `UPDATE auth.users SET failed_login_attempts = $2::smallint,
               locked_until = CASE WHEN $2::smallint >= $3::smallint THEN NOW() + ($4::text || ' minutes')::interval ELSE NULL END
             WHERE user_id = $1`, [user.user_id, attempts, maxAttempts(), String(lockMinutes())],
          );
        }
        await recordLogin(client, { userId: user?.user_id, email: input.email, success: false, failureReason: eligible ? 'INVALID_PASSWORD' : 'INVALID_ACCOUNT', req });
        authenticationFailed = true;
      } else {
        await client.query('UPDATE auth.users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE user_id = $1', [user.user_id]);
        await recordLogin(client, { userId: user.user_id, email: input.email, success: true, req });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }

  if (authenticationFailed) throw invalidCredentials();
  const session = await createSession({ userId: user.user_id, ...requestMetadata(req) });
  const profile = publicUser(user);
  return { user: profile, session, accessToken: signAccessToken({ userId: user.user_id, roleCode: user.role_code, sessionId: session.sessionId }) };
}

module.exports = { signup, login };

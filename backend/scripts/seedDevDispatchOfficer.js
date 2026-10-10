'use strict';
require('dotenv').config();

async function seedDevDispatchOfficer() {
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_DEMO_USERS !== 'true') {
    throw new Error('Dispatch Officer demo seed is disabled. Set NODE_ENV=development and SEED_DEMO_USERS=true to run it.');
  }

  const email = String(process.env.DEMO_DISPATCH_EMAIL || 'dispatch@gmail.com').trim().toLowerCase();
  const fullName = String(process.env.DEMO_DISPATCH_FULL_NAME || 'Demo Dispatch Officer').trim();
  const password = process.env.DEMO_DISPATCH_PASSWORD || 'admin123';
  if (!email || !fullName || password.length < 8) {
    throw new Error('Provide a valid DEMO_DISPATCH_EMAIL and DEMO_DISPATCH_FULL_NAME; DEMO_DISPATCH_PASSWORD must be at least 8 characters.');
  }

  const bcrypt = require('bcryptjs');
  const { pool, closePool } = require('../database/config/db');
  try {
    await require('../database/migrator/runner').runMigrations();
    const rounds = Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12)));
    const passwordHash = await bcrypt.hash(password, rounds);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT r.role_code FROM auth.users u
         JOIN auth.roles r USING (role_id)
         WHERE lower(u.email) = $1 FOR UPDATE OF u`, [email],
      );
      if (existing.rowCount) {
        if (existing.rows[0].role_code !== 'DISPATCH_OFFICER') {
          throw new Error(`${email} already exists with role ${existing.rows[0].role_code}; refusing to modify it.`);
        }
        await client.query('COMMIT');
        console.info(`Development Dispatch Officer account already exists (${email}); no changes made.`);
        return;
      }

      const role = await client.query(
        "SELECT role_id FROM auth.roles WHERE role_code = 'DISPATCH_OFFICER' AND is_active",
      );
      if (!role.rowCount) throw new Error('Active DISPATCH_OFFICER role is not available. Run database migrations first.');
      await client.query(
        `INSERT INTO auth.users (role_id, full_name, email, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, true)`,
        [role.rows[0].role_id, fullName, email, passwordHash],
      );
      await client.query('COMMIT');
      console.info(`Development Dispatch Officer account created (${email}). Password is hashed; change it at first sign-in.`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  seedDevDispatchOfficer().catch((error) => {
    console.error(`[Dispatch Officer seed] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = seedDevDispatchOfficer;

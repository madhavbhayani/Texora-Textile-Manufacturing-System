'use strict';
require('dotenv').config();

async function seedDevOwner() {
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_DEMO_USERS !== 'true') {
    throw new Error('Owner seed is disabled. Set NODE_ENV=development and SEED_DEMO_USERS=true to run it.');
  }

  const email = String(process.env.DEMO_OWNER_EMAIL || 'owner@gmail.com').trim().toLowerCase();
  const fullName = String(process.env.DEMO_OWNER_FULL_NAME || 'Texora Owner').trim();
  const phone = String(process.env.DEMO_OWNER_PHONE || '').trim() || null;
  const password = process.env.DEMO_OWNER_PASSWORD;
  if (!email || !fullName || !password) {
    throw new Error('Set DEMO_OWNER_PASSWORD and provide a valid DEMO_OWNER_EMAIL and DEMO_OWNER_FULL_NAME.');
  }
  if (password.length < 8) throw new Error('DEMO_OWNER_PASSWORD must be at least 8 characters.');

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
        if (existing.rows[0].role_code !== 'OWNER') {
          throw new Error(`${email} already exists with a different role; refusing to modify it.`);
        }
        throw new Error(`An Owner account already exists for ${email}; refusing to reset its password.`);
      }

      const role = await client.query("SELECT role_id FROM auth.roles WHERE role_code = 'OWNER' AND is_active");
      if (!role.rowCount) throw new Error('Active OWNER role is not available. Run database migrations first.');
      await client.query(
        `INSERT INTO auth.users (role_id, full_name, email, phone, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [role.rows[0].role_id, fullName, email, phone, passwordHash],
      );
      await client.query('COMMIT');
      console.info(`Development Owner account created (${email}). Password is hashed; change it at first sign-in.`);
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
  seedDevOwner().catch((error) => {
    console.error(`[Owner seed] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = seedDevOwner;

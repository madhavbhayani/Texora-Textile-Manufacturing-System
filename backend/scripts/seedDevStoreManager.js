'use strict';
require('dotenv').config();

const DEMO_USERS = [
  { email: 'storemanager@gmail.com', fullName: 'Demo Store Manager', role: 'STORE_MANAGER' },
  { email: 'supervisor@gmail.com', fullName: 'Demo Supervisor', role: 'SUPERVISOR' },
];

async function seedDevStoreManager() {
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_DEMO_USERS !== 'true') {
    throw new Error('Demo user seed is disabled. Set NODE_ENV=development and SEED_DEMO_USERS=true to run it.');
  }
  const bcrypt = require('bcryptjs');
  const { pool, closePool } = require('../database/config/db');
  try {
    await require('../database/migrator/runner').runMigrations();
    const rounds = Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12)));
    const passwordHash = await bcrypt.hash('admin123', rounds);
    for (const account of DEMO_USERS) {
      const existing = await pool.query('SELECT r.role_code FROM auth.users u JOIN auth.roles r USING(role_id) WHERE lower(u.email)=lower($1)', [account.email]);
      if (existing.rowCount) {
        if (existing.rows[0].role_code !== account.role) throw new Error(`${account.email} exists with a different role; refusing to modify it.`);
        console.info(`Development ${account.role} account already exists; no changes made.`);
        continue;
      }
      const role = await pool.query('SELECT role_id FROM auth.roles WHERE role_code=$1 AND is_active', [account.role]);
      if (!role.rowCount) throw new Error(`${account.role} role is not available. Run database migrations first.`);
      await pool.query('INSERT INTO auth.users(role_id,full_name,email,password_hash,must_change_password) VALUES($1,$2,$3,$4,true)', [role.rows[0].role_id, account.fullName, account.email, passwordHash]);
      console.info(`Development ${account.role} account created (${account.email}). Temporary password must be changed at first sign-in.`);
    }
  } finally { await closePool(); }
}

if (require.main === module) seedDevStoreManager().catch((error) => { console.error(`[Seed] ${error.message}`); process.exitCode = 1; });
module.exports = seedDevStoreManager;

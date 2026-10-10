'use strict';
require('dotenv').config();

async function seedDevStoreManager() {
  if (process.env.NODE_ENV !== 'development' || process.env.SEED_DEMO_USERS !== 'true') {
    throw new Error('Demo user seed is disabled. Set NODE_ENV=development and SEED_DEMO_USERS=true to run it.');
  }
  const bcrypt = require('bcryptjs');
  const { pool, closePool } = require('../database/config/db');
  try {
    const existing = await pool.query(`SELECT u.user_id,r.role_code FROM auth.users u JOIN auth.roles r USING(role_id) WHERE lower(u.email)=lower($1)`, ['storemanager@gmail.com']);
    if (existing.rowCount) {
      if (existing.rows[0].role_code !== 'STORE_MANAGER') throw new Error('storemanager@gmail.com exists with a different role; refusing to modify it.');
      console.info('Development Store Manager already exists; no changes made.');
      return;
    }
    const role = await pool.query(`SELECT role_id FROM auth.roles WHERE role_code='STORE_MANAGER' AND is_active`);
    if (!role.rowCount) throw new Error('STORE_MANAGER role is not available. Run database migrations first.');
    const rounds = Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS || 12)));
    const passwordHash = await bcrypt.hash('admin123', rounds);
    await pool.query(`INSERT INTO auth.users(role_id,full_name,email,password_hash,must_change_password) VALUES($1,$2,$3,$4,true)`, [role.rows[0].role_id, 'Demo Store Manager', 'storemanager@gmail.com', passwordHash]);
    console.info('Development Store Manager created. The temporary password must be changed at first sign-in.');
  } finally { await closePool(); }
}

if (require.main === module) seedDevStoreManager().catch((error) => { console.error(`[Seed] ${error.message}`); process.exitCode = 1; });
module.exports = seedDevStoreManager;

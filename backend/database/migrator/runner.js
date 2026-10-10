'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const checksum = require('./checksum');
const { pool } = require('../config/db');

const migrationDir = path.resolve(__dirname, '../migrations');
const requiredSchemas = ['core', 'auth', 'master', 'hr', 'sales', 'procurement', 'inventory', 'production', 'quality', 'dispatch', 'finance', 'notification', 'audit', 'reporting'];
const requiredColumns = {
  'auth.roles': ['role_id', 'role_code', 'is_active'],
  'auth.users': ['user_id', 'role_id', 'full_name', 'email', 'phone', 'password_hash', 'is_active', 'is_email_verified', 'is_phone_verified', 'failed_login_attempts', 'locked_until', 'last_login_at', 'created_at', 'updated_at'],
  'auth.sessions': ['session_id', 'user_id', 'refresh_token_hash', 'ip_address', 'user_agent', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'],
  'auth.login_events': ['login_event_id', 'user_id', 'login_identifier', 'success', 'failure_reason', 'ip_address', 'user_agent', 'created_at'],
  'master.buyers': ['buyer_id', 'buyer_code', 'user_id', 'company_name', 'credit_limit', 'credit_days', 'is_active', 'created_at', 'updated_at'],
  'master.buyer_addresses': ['address_id', 'buyer_id', 'address_type', 'line1', 'city', 'state', 'pincode', 'country', 'is_default', 'created_at', 'updated_at'],
};
const requiredTypes = {
  'auth.roles.role_id': 'bigint', 'auth.roles.role_code': 'text', 'auth.roles.is_active': 'boolean',
  'auth.users.user_id': 'bigint', 'auth.users.role_id': 'bigint', 'auth.users.full_name': 'text', 'auth.users.email': 'text',
  'auth.users.password_hash': 'text', 'auth.users.is_active': 'boolean', 'auth.users.failed_login_attempts': 'smallint',
  'auth.users.locked_until': 'timestamp with time zone',
  'auth.sessions.session_id': 'bigint', 'auth.sessions.user_id': 'bigint', 'auth.sessions.refresh_token_hash': 'text',
  'auth.sessions.expires_at': 'timestamp with time zone', 'auth.sessions.revoked_at': 'timestamp with time zone',
  'master.buyers.buyer_id': 'bigint', 'master.buyers.user_id': 'bigint', 'master.buyers.company_name': 'text',
  'master.buyers.credit_limit': 'numeric', 'master.buyers.credit_days': 'integer',
};

async function discoverMigrations() {
  const files = (await fs.readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
  return Promise.all(files.map(async (name) => {
    const sql = await fs.readFile(path.join(migrationDir, name), 'utf8');
    return { name, sql, checksum: checksum(sql) };
  }));
}

async function hasApplicationSchema(client) {
  const result = await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ANY($1::text[])) AS present", [requiredSchemas]);
  return result.rows[0].present;
}

async function validateExistingSchema(client) {
  const missing = [];
  const schemas = await client.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])', [requiredSchemas]);
  const foundSchemas = new Set(schemas.rows.map((row) => row.schema_name));
  for (const schema of requiredSchemas) if (!foundSchemas.has(schema)) missing.push(`schema ${schema}`);
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const [schema, name] = table.split('.');
    const result = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, name]);
    const found = new Set(result.rows.map((row) => row.column_name));
    for (const column of columns) if (!found.has(column)) missing.push(`column ${table}.${column}`);
  }
  if (missing.length) throw new Error(`Existing Texora database is partial or incompatible. Missing: ${missing.join(', ')}. Review the schema and restore from the original setup before migrating.`);
  const incompatible = [];
  for (const [qualifiedColumn, expectedType] of Object.entries(requiredTypes)) {
    const [schema, table, column] = qualifiedColumn.split('.');
    const result = await client.query('SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, table, column]);
    if (result.rows[0]?.data_type !== expectedType) incompatible.push(`${qualifiedColumn} should be ${expectedType}`);
  }
  if (incompatible.length) throw new Error(`Existing Texora database has incompatible column types: ${incompatible.join(', ')}.`);
  const roles = await client.query("SELECT role_code FROM auth.roles WHERE role_code = ANY($1::text[]) AND is_active", [['OWNER', 'BUYER', 'STORE_MANAGER', 'SUPERVISOR', 'WORKER', 'DISPATCH_OFFICER']]);
  const foundRoles = new Set(roles.rows.map((row) => row.role_code));
  for (const role of ['OWNER', 'BUYER', 'STORE_MANAGER', 'SUPERVISOR', 'WORKER', 'DISPATCH_OFFICER']) if (!foundRoles.has(role)) missing.push(`seeded role ${role}`);
  if (missing.length) throw new Error(`Existing Texora database is partial or incompatible. Missing: ${missing.join(', ')}. Review the schema and restore from the original setup before migrating.`);
}

async function applyMigration(migration, mode = 'EXECUTED') {
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query('BEGIN');
    if (mode === 'EXECUTED') await client.query(migration.sql);
    await client.query(
      'INSERT INTO public.migrations (migration_name, checksum, execution_time_ms, applied_mode) VALUES ($1, $2, $3, $4)',
      [migration.name, migration.checksum, Date.now() - started, mode],
    );
    await client.query('COMMIT');
    console.info(`[Migrator] ${migration.name} ${mode === 'BASELINED' ? 'baselined' : 'completed successfully'}.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    error.migrationName = migration.name;
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations() {
  console.info('[Migrator] Checking migration history...');
  const lockClient = await pool.connect();
  let locked = false;
  try {
    await lockClient.query('CREATE TABLE IF NOT EXISTS public.migrations (migration_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, migration_name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), execution_time_ms INTEGER NOT NULL DEFAULT 0, applied_mode TEXT NOT NULL DEFAULT \'EXECUTED\' CHECK (applied_mode IN (\'EXECUTED\', \'BASELINED\')))');
    await lockClient.query('SELECT pg_advisory_lock(842731, 1)');
    locked = true;
    const migrations = await discoverMigrations();
    if (!migrations.length) throw new Error('No SQL migration files were found in database/migrations.');
    const historyResult = await lockClient.query('SELECT migration_name, checksum, applied_mode FROM public.migrations ORDER BY migration_name');
    const history = new Map(historyResult.rows.map((row) => [row.migration_name, { checksum: row.checksum, mode: row.applied_mode }]));
    for (const [name, applied] of history) {
      const migration = migrations.find((item) => item.name === name);
      if (!migration) throw new Error(`Applied migration ${name} is missing from database/migrations.`);
      if (migration.checksum !== applied.checksum) throw new Error(`Checksum mismatch for applied migration ${name}; restore the original file or create a new migration.`);
    }
    if (history.size === 0) {
      const initial = migrations.find((item) => item.name === '001_initial_schema.sql');
      if (!initial) throw new Error('Required baseline migration 001_initial_schema.sql is missing.');
      if (await hasApplicationSchema(lockClient)) {
        await validateExistingSchema(lockClient);
        await applyMigration(initial, 'BASELINED');
        history.set(initial.name, { checksum: initial.checksum, mode: 'BASELINED' });
      }
    }
    for (const migration of migrations) {
      if (history.has(migration.name)) {
        const mode = history.get(migration.name).mode;
        console.info(`[Migrator] ${migration.name} already ${mode === 'BASELINED' ? 'baselined' : 'applied'}.`);
        continue;
      }
      console.info(`[Migrator] Applying ${migration.name}...`);
      await applyMigration(migration);
      history.set(migration.name, { checksum: migration.checksum, mode: 'EXECUTED' });
    }
    console.info('[Migrator] All migrations are up to date.');
  } catch (error) {
    console.error(`[Migrator] Failed${error.migrationName ? ` on ${error.migrationName}` : ''}: ${error.message}`);
    throw error;
  } finally {
    if (locked) await lockClient.query('SELECT pg_advisory_unlock(842731, 1)').catch(() => {});
    lockClient.release();
  }
}

module.exports = { runMigrations, validateExistingSchema, discoverMigrations };

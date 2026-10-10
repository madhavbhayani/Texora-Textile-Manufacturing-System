'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const hasDiscreteConfig = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'].some((name) => process.env[name] !== undefined);
if (connectionString && hasDiscreteConfig) throw new Error('Configure DATABASE_URL or individual DATABASE_* values, not both.');
if (!connectionString && !(process.env.DATABASE_HOST && process.env.DATABASE_NAME && process.env.DATABASE_USER)) {
  throw new Error('Database configuration is incomplete. Set DATABASE_URL or DATABASE_HOST, DATABASE_NAME, and DATABASE_USER.');
}

const sslEnabled = process.env.DATABASE_SSL === 'true' || process.env.PGSSLMODE === 'require';
const pool = new Pool({
  ...(connectionString ? { connectionString } : {
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
  }),
  max: Math.max(2, Number(process.env.DATABASE_POOL_MAX || 10)),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000),
  ...(sslEnabled ? { ssl: { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' } } : {}),
  application_name: 'texora-api',
});

pool.on('error', (error) => console.error('[Database] Idle client error:', error.code || 'UNKNOWN'));
async function testConnection() {
  const result = await pool.query('SELECT 1 AS connected');
  return result.rows[0].connected === 1;
}

module.exports = { pool, testConnection, closePool: () => pool.end() };

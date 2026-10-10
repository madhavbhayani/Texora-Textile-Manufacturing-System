'use strict';

require('dotenv').config();
const http = require('node:http');
const { validateEnvironment, corsError } = require('./config/env');

function createApp(origins) {
  const express = require('express');
  const cors = require('cors');
  const helmet = require('helmet');
  const cookieParser = require('cookie-parser');
  const { rateLimit } = require('express-rate-limit');
  const buyerRoutes = require('./modules/buyers/routes/buyerRoutes');
  const authRoutes = require('./modules/auth/routes/authRoutes');
  const productRoutes = require('./modules/orders/routes/productRoutes');
  const orderRoutes = require('./modules/orders/routes/orderRoutes');
  const storeManagerRoutes = require('./modules/store-manager/routes/storeManagerRoutes');
  const notFound = require('./shared/middleware/notFound');
  const errorHandler = require('./shared/middleware/errorHandler');
  const { pool } = require('./database/config/db');
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.use(helmet());
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || origins.includes(origin)) return callback(null, true);
      callback(corsError());
    },
  }));
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '20kb', strict: true }));
  app.use(cookieParser());

  const authLimiter = rateLimit({
    windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.AUTH_RATE_LIMIT || 20),
    standardHeaders: 'draft-8', legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Please try again later.' } },
  });
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ success: true, data: { status: 'ok', database: 'ready' } });
    } catch {
      res.status(503).json({ success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'The service is temporarily unavailable.' } });
    }
  });
  app.use('/api/buyers/signup', authLimiter);
  app.use('/api/buyers/login', authLimiter);
  app.use('/api/auth', authLimiter);
  app.use('/api/buyers', buyerRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/store-manager', storeManagerRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

async function startServer() {
  let closePool;
  let server;
  try {
    console.info('[Texora] Starting application...');
    const { origins, port } = validateEnvironment();
    const database = require('./database/config/db');
    closePool = database.closePool;
    console.info('[Database] Connecting to PostgreSQL...');
    await database.testConnection();
    console.info('[Database] Connection successful.');
    const { runMigrations } = require('./database/migrator/runner');
    await runMigrations();

    const app = createApp(origins);
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => { server.removeListener('error', reject); resolve(); });
    });
    console.info(`[Server] Listening on port ${port}.`);

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.info(`[Server] ${signal} received; shutting down.`);
      server.close(async (error) => {
        if (error) console.error('[Server] HTTP shutdown error:', error.code || 'UNKNOWN');
        try { await closePool(); console.info('[Database] Connection pool closed.'); }
        catch (closeError) { console.error('[Database] Pool shutdown error:', closeError.code || 'UNKNOWN'); process.exitCode = 1; }
      });
      server.closeIdleConnections?.();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return server;
  } catch (error) {
    console.error('[Texora] Startup failed:', error.migrationName ? `${error.migrationName}: ${error.message}` : error.message);
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (closePool) await closePool().catch((closeError) => console.error('[Database] Pool close failed:', closeError.code || 'UNKNOWN'));
    throw error;
  }
}

if (require.main === module) startServer().catch(() => { process.exitCode = 1; });
module.exports = { startServer, createApp };

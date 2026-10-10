'use strict';

require('dotenv').config();
const { runMigrations } = require('./runner');
const { closePool } = require('../config/db');

runMigrations().catch((error) => {
  console.error('[Database] Migration command stopped:', error.message);
  process.exitCode = 1;
}).finally(closePool);

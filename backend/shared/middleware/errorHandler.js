'use strict';

module.exports = function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.status >= 500 || !error.expose) {
    console.error('[Error]', { code: error.code || 'INTERNAL_ERROR', message: error.message });
  }
  res.status(error.status || 500).json({
    success: false,
    error: { code: error.code || 'INTERNAL_ERROR', message: error.expose ? error.message : 'An unexpected error occurred.' },
  });
};

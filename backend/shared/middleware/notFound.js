'use strict';

const AppError = require('../errors/AppError');
module.exports = function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found.'));
};

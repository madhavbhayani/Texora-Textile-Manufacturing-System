'use strict';

const AppError = require('../../../shared/errors/AppError');

module.exports = function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.auth) return next(new AppError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.'));
    if (req.auth.mustChangePassword) return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password before using this workspace.'));
    if (!allowedRoles.includes(req.auth.roleCode)) return next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'));
    next();
  };
};

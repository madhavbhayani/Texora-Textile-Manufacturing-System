'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');

module.exports = permissionCode => async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM auth.users u
         JOIN auth.role_permissions rp ON rp.role_id = u.role_id
         JOIN auth.permissions p ON p.permission_id = rp.permission_id
         WHERE u.user_id = $1 AND u.is_active AND p.permission_code = $2
       ) AS allowed`,
      [req.auth.userId, permissionCode],
    );
    if (!result.rows[0]?.allowed) return next(new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.'));
    return next();
  } catch (error) {
    return next(error);
  }
};

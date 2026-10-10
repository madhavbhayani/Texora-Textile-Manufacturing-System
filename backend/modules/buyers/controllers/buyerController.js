'use strict';

const validator = require('../validators/buyerValidator');
const buyerService = require('../services/buyerService');
const { setCredentials } = require('../../auth/controllers/authController');

async function signup(req, res, next) {
  try {
    const result = await buyerService.signup(validator.validateSignup(req.body), req);
    const credentials = setCredentials(res, result.session, result.accessToken);
    res.status(201).json({ success: true, message: 'Account created successfully.', data: { user: result.user, ...credentials } });
  } catch (error) { next(error); }
}
async function login(req, res, next) {
  try {
    const result = await buyerService.login(validator.validateLogin(req.body), req);
    const credentials = setCredentials(res, result.session, result.accessToken);
    res.json({ success: true, message: 'Signed in successfully.', data: { user: result.user, ...credentials } });
  } catch (error) { next(error); }
}
module.exports = { signup, login };

'use strict';

const express = require('express');
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/authController');
const router = express.Router();

router.get('/me', authenticate, controller.me);
router.post('/change-password', authenticate, controller.changePassword);
router.get('/csrf', controller.csrf);
router.post('/refresh', controller.refresh);
router.post('/logout', controller.logout);

module.exports = router;

'use strict';
const express = require('express');
const authenticate = require('../../auth/middleware/authenticate');
const authorize = require('../../auth/middleware/authorize');
const controller = require('../controllers/orderController');
const router = express.Router();

router.use(authenticate);
router.post('/', authorize('BUYER'), controller.create);
router.get('/addresses', authorize('BUYER'), controller.addresses);
router.post('/addresses', authorize('BUYER'), controller.createAddress);
router.delete('/addresses/:addressId', authorize('BUYER'), controller.deleteAddress);
router.get('/my', authorize('BUYER'), controller.my);
router.get('/', authorize('OWNER'), controller.list);
router.get('/:orderId', authorize('BUYER', 'OWNER'), controller.detail);
module.exports = router;

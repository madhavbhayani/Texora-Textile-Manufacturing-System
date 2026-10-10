'use strict';

const AppError = require('../../../shared/errors/AppError');
const service = require('../services/orderService');
const { validateOrder, validateAddress, validateAddressId } = require('../validators/orderValidator');
function page(req) {
  const limit = Number(req.query.limit ?? 20); const offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new AppError(400, 'INVALID_PAGINATION', 'Use a limit from 1 to 100 and a nonnegative offset.');
  return { limit, offset };
}
async function create(req, res, next) { try { const result = await service.createOrder(req.auth.userId, validateOrder(req.body)); res.status(201).json({ success: true, message: 'Order placed successfully.', data: { order: result } }); } catch (error) { next(error); } }
async function my(req, res, next) { try { const result = await service.getOrders({ userId: req.auth.userId, roleCode: req.auth.roleCode, ...page(req) }); res.json({ success: true, data: { orders: result } }); } catch (error) { next(error); } }
async function list(req, res, next) { try { const result = await service.getOrders({ userId: req.auth.userId, roleCode: req.auth.roleCode, ...page(req) }); res.json({ success: true, data: { orders: result } }); } catch (error) { next(error); } }
async function detail(req, res, next) { try { const order = await service.getOrders({ userId: req.auth.userId, roleCode: req.auth.roleCode, orderId: req.params.orderId, limit: 1, offset: 0 }); res.json({ success: true, data: { order } }); } catch (error) { next(error); } }
async function addresses(req, res, next) { try { res.json({ success: true, data: { addresses: await service.getBuyerAddresses(req.auth.userId) } }); } catch (error) { next(error); } }
async function createAddress(req, res, next) { try { const address = await service.createBuyerAddress(req.auth.userId, validateAddress(req.body)); res.status(201).json({ success: true, data: { address } }); } catch (error) { next(error); } }
async function deleteAddress(req, res, next) { try { await service.deleteBuyerAddress(req.auth.userId, validateAddressId(req.params.addressId)); res.json({ success: true, data: { deleted: true } }); } catch (error) { next(error); } }
module.exports = { create, my, list, detail, addresses, createAddress, deleteAddress };

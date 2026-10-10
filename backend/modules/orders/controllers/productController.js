'use strict';

const AppError = require('../../../shared/errors/AppError');
const service = require('../services/productService');
const validator = require('../validators/productValidator');
function paging(query) {
  const limit = Number(query.limit ?? 24); const offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new AppError(400, 'INVALID_PAGINATION', 'Use a limit from 1 to 100 and a nonnegative offset.');
  return { limit, offset };
}
async function list(req, res, next) {
  try {
    const { limit, offset } = paging(req.query);
    const minGsm = req.query.minGsm == null ? null : Number(req.query.minGsm);
    const maxGsm = req.query.maxGsm == null ? null : Number(req.query.maxGsm);
    if ([minGsm, maxGsm].some((value) => value != null && (!Number.isInteger(value) || value < 1 || value > 10000)) || (minGsm != null && maxGsm != null && minGsm > maxGsm)) throw new AppError(400, 'INVALID_FILTER', 'GSM filters must be valid positive ranges.');
    for (const key of ['q', 'category', 'weave']) if (typeof req.query[key] === 'string' && req.query[key].length > 100) throw new AppError(400, 'INVALID_FILTER', `${key} filter is too long.`);
    const products = await service.listPublic({ search: String(req.query.q || '').trim(), category: String(req.query.category || '').trim().toUpperCase(), weave: String(req.query.weave || '').trim(), minGsm, maxGsm, limit, offset });
    res.json({ success: true, data: { products, pagination: { limit, offset } } });
  } catch (error) { next(error); }
}
async function detail(req, res, next) { try { res.json({ success: true, data: { product: await service.getPublic(req.params.productId) } }); } catch (error) { next(error); } }
async function ownerList(req, res, next) { try { res.json({ success: true, data: { products: await service.listOwner(paging(req.query)) } }); } catch (error) { next(error); } }
async function ownerDetail(req, res, next) { try { res.json({ success: true, data: { product: await service.getOwner(req.params.productId) } }); } catch (error) { next(error); } }
async function create(req, res, next) { try { const product = await service.createProduct(req.auth.userId, validator.validateProduct(req.body)); res.status(201).json({ success: true, data: { product } }); } catch (error) { next(error); } }
async function update(req, res, next) { try { const product = await service.updateProduct(req.auth.userId, req.params.productId, validator.validateProduct(req.body, true)); res.json({ success: true, data: { product } }); } catch (error) { next(error); } }
async function publish(req, res, next) { try { if (typeof req.body?.published !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', 'published must be true or false.'); const product = await service.setProductState(req.auth.userId, req.params.productId, 'is_published', req.body.published); res.json({ success: true, data: { product } }); } catch (error) { next(error); } }
async function archive(req, res, next) { try { const product = await service.setProductState(req.auth.userId, req.params.productId, 'is_active', false); res.json({ success: true, data: { product } }); } catch (error) { next(error); } }
async function colours(req, res, next) { try { const result = req.method === 'GET' ? await service.listColours() : await service.replaceColours(req.auth.userId, req.params.productId, validator.validateColours(req.body?.colours)); res.json({ success: true, data: { colours: result } }); } catch (error) { next(error); } }
async function bom(req, res, next) { try { const result = await service.replaceBom(req.auth.userId, req.params.productId, validator.validateBom(req.body?.lines)); res.json({ success: true, data: result }); } catch (error) { next(error); } }
async function attributes(req, res, next) { try { const result = req.method === 'GET' ? await service.listDefinitions() : await service.replaceAttributes(req.auth.userId, req.params.productId, validator.validateAttributes(req.body?.attributes)); res.json({ success: true, data: { attributes: result } }); } catch (error) { next(error); } }
async function yarns(req, res, next) { try { res.json({ success: true, data: { yarns: await service.listYarns() } }); } catch (error) { next(error); } }
module.exports = { list, detail, ownerList, ownerDetail, create, update, publish, archive, colours, bom, attributes, yarns };

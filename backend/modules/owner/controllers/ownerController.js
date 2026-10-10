'use strict';

const service = require('../services/ownerService');
const AppError = require('../../../shared/errors/AppError');

const actor = req => req.auth.userId;
function send(fn, status = 200, key = 'result') {
  return async (req,res,next) => { try { const value=await fn(req); res.status(status).json({success:true,data:{[key]:value}}); } catch(error) { next(error); } };
}
function body(req) { if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)) throw new AppError(400,'VALIDATION_ERROR','Request body must be an object.'); return req.body; }
module.exports = {
  dashboard: send(req=>service.dashboard(req.query),200,'dashboard'),
  section: send(req=>service.section(req.params.section,req.query,actor(req)),200,'section'),
  invoices: send(req=>service.supplierInvoices(req.query),200,'invoices'),
  invoice: send(req=>service.invoiceDetail(req.params.invoiceId),200,'invoice'),
  approveInvoice: send(req=>service.approveInvoice(actor(req),req.params.invoiceId,body(req).reason),200,'approval'),
  correctInvoice: send(req=>service.requestInvoiceCorrection(actor(req),req.params.invoiceId,body(req).reason),200,'review'),
  voidInvoice: send(req=>service.voidInvoice(actor(req),req.params.invoiceId,body(req).reason),200,'invoice'),
  payments: send(req=>service.supplierPayments(req.query),200,'payments'),
  recordPayment: send(req=>service.recordSupplierPayment(actor(req),body(req)),201,'payment'),
  completePayment: send(req=>service.completeSupplierPayment(actor(req),req.params.paymentId),200,'payment'),
  user: send(req=>service.userDetail(req.params.userId),200,'user'),
  updateUserRole: send(req=>service.updateUserRole(actor(req),req.params.userId,body(req).roleCode),200,'user'),
  updateSetting: send(req=>service.updateSetting(actor(req),req.params.key,body(req).value),200,'setting'),
};

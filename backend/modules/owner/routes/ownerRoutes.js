'use strict';
const express=require('express');
const authenticate=require('../../auth/middleware/authenticate');
const authorize=require('../../auth/middleware/authorize');
const c=require('../controllers/ownerController');
const requirePermission=require('../middleware/requirePermission');
const router=express.Router();
router.use(authenticate,authorize('OWNER'));
const sectionPermission=(req,res,next)=>{
 const code={finance:'finance.view','customer-invoices':'finance.view','supplier-payments':'finance.view',workforce:'hr.manage',users:'users.manage',reports:'reports.view','audit-log':'reports.view'}[req.params.section]||'dashboard.view_all';
 return requirePermission(code)(req,res,next);
};
router.get('/dashboard',requirePermission('dashboard.view_all'),c.dashboard);
// Section names are an explicit allowlist in ownerService; no arbitrary table access is exposed.
router.get('/sections/:section',sectionPermission,c.section);
router.get('/supplier-invoices',requirePermission('procurement.manage'),c.invoices);
router.get('/supplier-invoices/:invoiceId/approval-preview',requirePermission('procurement.manage'),c.invoice);
router.get('/supplier-invoices/:invoiceId',requirePermission('procurement.manage'),c.invoice);
router.post('/supplier-invoices/:invoiceId/approve',requirePermission('procurement.manage'),c.approveInvoice);
router.post('/supplier-invoices/:invoiceId/request-correction',requirePermission('procurement.manage'),c.correctInvoice);
router.post('/supplier-invoices/:invoiceId/void',requirePermission('procurement.manage'),c.voidInvoice);
router.get('/supplier-payments',requirePermission('finance.view'),c.payments);
router.post('/supplier-payments',requirePermission('finance.manage_supplier'),c.recordPayment);
router.post('/supplier-payments/:paymentId/complete',requirePermission('finance.manage_supplier'),c.completePayment);
router.get('/users/:userId',requirePermission('users.manage'),c.user);
router.patch('/users/:userId/role',requirePermission('users.manage'),c.updateUserRole);
router.put('/settings/:key',requirePermission('dashboard.view_all'),c.updateSetting);
module.exports=router;

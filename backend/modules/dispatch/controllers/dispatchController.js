'use strict';
const service=require('../services/dispatchService');
const {createInvoicePdf}=require('../utils/invoicePdf');
const AppError=require('../../../shared/errors/AppError');
const actor=req=>req.auth;
function send(fn,status=200,key='result'){return async(req,res,next)=>{try{const value=await fn(req);res.status(status).json({success:true,data:{[key]:value}});}catch(error){next(error);}};}
function body(req){if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AppError(400,'VALIDATION_ERROR','Request body must be an object.');return req.body;}
function id(value,label){if(!/^[1-9]\d*$/.test(String(value??'')))throw new AppError(400,'VALIDATION_ERROR',`${label} must be a positive integer.`);return value;}
module.exports={
 dashboard:send(()=>service.dashboard(),200,'dashboard'),queue:send(req=>service.queue(req.query),200,'orders'),orderDetail:send(req=>service.orderDetail(req.params.orderId),200,'order'),eligibleRolls:send(req=>service.eligibleRolls(req.query.orderId),200,'rolls'),
 shipments:send(req=>service.shipments(req.query),200,'shipments'),shipment:send(req=>service.shipment(req.params.shipmentId),200,'shipment'),
 createShipment:send(req=>service.createShipment(actor(req).userId,id(body(req).orderId,'Order ID')),201,'shipment'),
 addRolls:send(req=>service.addRolls(actor(req).userId,req.params.shipmentId,body(req).rollIds),201,'shipment'),
 removeRoll:send(req=>service.removeRoll(actor(req).userId,req.params.shipmentId,req.params.itemId),200,'shipment'),
 pack:send(req=>service.transition(actor(req).userId,req.params.shipmentId,'PACKED'),200,'shipment'),
 ship:send(req=>service.transition(actor(req).userId,req.params.shipmentId,'SHIPPED',body(req)),200,'shipment'),
 deliver:send(req=>service.transition(actor(req).userId,req.params.shipmentId,'DELIVERED'),200,'shipment'),
 cancel:send(req=>service.transition(actor(req).userId,req.params.shipmentId,'CANCELLED',body(req)),200,'shipment'),
 createInvoice:send(req=>{const b=body(req);if(b.dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate))throw new AppError(400,'VALIDATION_ERROR','Due date must use YYYY-MM-DD.');if(String(b.notes||'').length>1000)throw new AppError(400,'VALIDATION_ERROR','Invoice notes cannot exceed 1000 characters.');return service.createInvoice(actor(req).userId,req.params.shipmentId,b.dueDate,b.notes);},201,'invoice'),
 invoices:send(req=>service.invoices(req.query),200,'invoices'),myInvoices:send(req=>service.myInvoices(actor(req).userId,req.query),200,'invoices'),buyerPayment:send(req=>{const b=body(req);const paymentMode=String(b.paymentMode||'').trim().toUpperCase();if(!['UPI','BANK_TRANSFER','CASH','OTHER'].includes(paymentMode))throw new AppError(400,'VALIDATION_ERROR','Choose a supported payment mode.');const details=String(b.details||'').trim();if(details.length<3||details.length>250)throw new AppError(400,'VALIDATION_ERROR','Payment details must be between 3 and 250 characters.');return service.recordBuyerPayment(actor(req).userId,req.params.invoiceId,{paymentMode,details});},201,'invoice'),notifications:send(req=>service.notifications(actor(req).userId,req.query),200,'notifications'),invoice:send(req=>service.invoice(req.params.invoiceId),200,'invoice'),
 invoicePdf:async(req,res,next)=>{try{const invoice=await service.invoicePdfData(req.params.invoiceId,actor(req));const pdf=createInvoicePdf(invoice);const filename=`${String(invoice.invoice_no).replace(/[^a-zA-Z0-9_-]/g,'_')}.pdf`;res.set({'Content-Type':'application/pdf','Content-Length':String(pdf.length),'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'private, no-store'});res.send(pdf);}catch(error){next(error);}},
};

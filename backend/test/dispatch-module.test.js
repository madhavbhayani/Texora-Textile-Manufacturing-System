'use strict';
process.env.DATABASE_HOST ||= '127.0.0.1';
process.env.DATABASE_NAME ||= 'texora_test';
process.env.DATABASE_USER ||= 'texora_test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pool}=require('../database/config/db');
const service=require('../modules/dispatch/services/dispatchService');
const authorize=require('../modules/auth/middleware/authorize');
const {createInvoicePdf}=require('../modules/dispatch/utils/invoicePdf');
const originalQuery=pool.query.bind(pool),originalConnect=pool.connect.bind(pool);
test.afterEach(()=>{pool.query=originalQuery;pool.connect=originalConnect;});

test('dispatch actions reject non-dispatch roles',()=>{
 const gate=authorize('DISPATCH_OFFICER','OWNER');
 for(const roleCode of ['BUYER','STORE_MANAGER','SUPERVISOR','WORKER']){let error;gate({auth:{roleCode,mustChangePassword:false}},{},value=>{error=value;});assert.equal(error.status,403);}
 let passed=false;gate({auth:{roleCode:'DISPATCH_OFFICER',mustChangePassword:false}},{},error=>{passed=error===undefined;});assert.equal(passed,true);
});

test('shipment creation uses the verified actor and returns the persisted shipment',async()=>{
 const writes=[];pool.connect=async()=>({query:async(sql,args=[])=>{writes.push({sql,args});if(sql.includes('SELECT order_id,status FROM sales.orders'))return {rowCount:1,rows:[{order_id:'21',status:'READY_TO_SHIP'}]};if(sql.includes('INSERT INTO dispatch.shipments'))return {rowCount:1,rows:[{shipment_id:'70'}]};return {rowCount:1,rows:[]};},release(){}});
 pool.query=async(sql)=>sql.includes('WHERE shipment_id=$1')?{rowCount:1,rows:[{shipment_id:'70',shipment_no:'SHP-0070',order_no:'ORD-0021',status:'DRAFT',items:[]}]}:{rowCount:0,rows:[]};
 const result=await service.createShipment('44','21');assert.equal(result.shipment_id,'70');
 assert.deepEqual(writes.find(x=>x.sql.includes("set_config('app.current_user_id'")).args,['44']);
 assert.deepEqual(writes.find(x=>x.sql.includes('INSERT INTO dispatch.shipments')).args,['21','44']);
});

test('dispatch dashboard uses a PostgreSQL-safe date alias for the volume series',async()=>{
 const statements=[];
 pool.query=async(sql)=>{statements.push(sql);if(sql.includes('reporting.customer_order_tracking'))return {rows:[],rowCount:0};if(sql.includes('reporting.customer_invoice_balances'))return {rows:[{}],rowCount:1};if(sql.includes('shipped_at::date AS dispatch_date'))return {rows:[],rowCount:0};if(sql.includes('GROUP BY status'))return {rows:[],rowCount:0};return {rows:[],rowCount:0};};
 await service.dashboard();
 const trend=statements.find(sql=>sql.includes('shipped_at::date AS dispatch_date'));
 assert.ok(trend);
 assert.match(trend,/ORDER BY dispatch_date/);
 assert.doesNotMatch(trend,/\bAS day\b|ORDER BY day\b/i);
});

test('shipment detail uses explicit keys when joining roll, job, and order item records',async()=>{
 const statements=[];
 pool.query=async(sql)=>{statements.push(sql);if(sql.includes('WHERE shipment_id=$1'))return {rowCount:1,rows:[{shipment_id:'70',shipment_no:'SHP-0070'}]};return {rowCount:0,rows:[]};};
 const result=await service.shipment('70');
 const itemsSql=statements.find(sql=>sql.includes('SELECT si.shipment_item_id'));
 assert.equal(result.shipment_id,'70');
 assert.match(itemsSql,/JOIN production\.jobs j ON j\.job_id=r\.job_id/);
 assert.match(itemsSql,/JOIN sales\.order_items oi ON oi\.order_item_id=r\.order_item_id/);
 assert.doesNotMatch(itemsSql,/USING\s*\(\s*order_item_id\s*\)/i);
});

test('invoice detail joins shipment by an explicit key to avoid duplicate USING columns',async()=>{
 const statements=[];
 pool.query=async(sql)=>{statements.push(sql);if(sql.includes('FROM reporting.customer_invoice_balances ib'))return {rowCount:1,rows:[{customer_invoice_id:'9',shipment_id:'70'}]};return {rowCount:0,rows:[]};};
 const result=await service.invoice('9');
 const headerSql=statements.find(sql=>sql.includes('FROM reporting.customer_invoice_balances ib'));
 assert.equal(result.shipment_id,'70');
 assert.match(headerSql,/JOIN dispatch\.shipments sh ON sh\.shipment_id=ci\.shipment_id/);
 assert.doesNotMatch(headerSql,/JOIN dispatch\.shipments sh USING\s*\(shipment_id\)/i);
});

test('customer invoice document generator returns a valid PDF using persisted invoice values',()=>{
 const pdf=createInvoicePdf({invoice_no:'INV-0042',invoice_status:'ISSUED',invoice_date:'2026-10-10',due_date:'2026-10-25',order_no:'ORD-0007',shipment_no:'SHP-0011',company_name:'Example Buyer',buyer_code:'BUY-0001',subtotal:'1000.00',tax_amount:'50.00',total_amount:'1050.00',net_paid:'0',balance_due:'1050.00',payment_status:'UNPAID',shipment_status:'SHIPPED',lines:[{description:'Cotton fabric',roll_no:'ROLL-0003',quantity_m:'10',rate_per_m:'100',tax_percent:'5',line_subtotal:'1000',line_tax:'50',line_total:'1050'}]});
 const content=pdf.toString('ascii');assert.ok(content.startsWith('%PDF-1.4'));assert.match(content,/xref\n/);assert.match(content,/INV-0042/);assert.match(content,/ROLL-0003/);assert.match(content,/%%EOF$/);
});

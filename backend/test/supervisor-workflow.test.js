'use strict';
process.env.DATABASE_HOST ||= '127.0.0.1';
process.env.DATABASE_NAME ||= 'texora_test';
process.env.DATABASE_USER ||= 'texora_test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {pool}=require('../database/config/db');
const service=require('../modules/supervisor/services/supervisorService');
const authorize=require('../modules/auth/middleware/authorize');

const originalQuery=pool.query.bind(pool),originalConnect=pool.connect.bind(pool);
test.afterEach(()=>{pool.query=originalQuery;pool.connect=originalConnect;});

test('Supervisor authorization rejects Store Manager and Buyer roles',()=>{
 const gate=authorize('SUPERVISOR','OWNER');
 for(const roleCode of ['STORE_MANAGER','BUYER','WORKER']){let error;gate({auth:{roleCode,mustChangePassword:false}},{},value=>{error=value;});assert.equal(error.status,403);}
 let passed=false;gate({auth:{roleCode:'SUPERVISOR',mustChangePassword:false}},{},error=>{passed=error===undefined;});assert.equal(passed,true);
});

test('incoming handoff query is scoped to the authenticated Supervisor',async()=>{
 let sql,args;pool.query=async(query,values)=>{sql=query;args=values;return {rows:[]};};
 await service.handoffs('481',{limit:'10'});
 assert.match(sql,/WHERE h\.supervisor_user_id=\$1/);assert.equal(args[0],'481');assert.equal(args[1],10);
});

test('production job creation records the verified Supervisor as actor and creator',async()=>{
 const calls=[];pool.connect=async()=>({query:async(sql,args=[])=>{calls.push({sql,args});
   if(sql.includes('SELECT h.*,oi.fabric_type_id'))return {rowCount:1,rows:[{handoff_id:'9',order_item_id:'30',fabric_type_id:'4',stage:'WEAVING',planned_meters:'50',status:'ACCEPTED',production_job_id:null,order_status:'PLACED',handoff_no:'HOF-0009',notes:null,created_by:'17'}]};
   if(sql.includes('SELECT job_id FROM production.jobs'))return {rowCount:0,rows:[]};
   if(sql.includes('INSERT INTO production.jobs'))return {rowCount:1,rows:[{job_id:'77',job_no:'JOB-0077',status:'PLANNED'}]};
   if(sql.includes('UPDATE production.store_handoffs'))return {rowCount:1,rows:[]};
   return {rowCount:1,rows:[]};},release(){}});
 const result=await service.createJob('481','9');
 assert.equal(result.job_no,'JOB-0077');const actorCall=calls.find(call=>call.sql.includes("set_config('app.current_user_id'"));assert.equal(actorCall.args[0],'481');
 const insert=calls.find(call=>call.sql.includes('INSERT INTO production.jobs'));
 assert.equal(insert.args[3],'481');assert.match(insert.sql,/created_by/);
 assert.ok(calls.some(call=>call.sql.includes("set_config('app.current_user_id'")));
});

test('Supervisor worker provisioning creates a hashed WORKER login and assigns a default shift',async()=>{
 const calls=[];let released=false;pool.connect=async()=>({query:async(sql,args=[])=>{calls.push({sql,args});
   if(sql.includes('SELECT shift_id FROM master.shifts'))return {rowCount:1,rows:[{shift_id:'3'}]};
   if(sql.includes('SELECT 1 FROM auth.users'))return {rowCount:0,rows:[]};
   if(sql.includes("role_code='WORKER'"))return {rowCount:1,rows:[{role_id:'6'}]};
   if(sql.includes('INSERT INTO auth.users'))return {rowCount:1,rows:[{user_id:'91',full_name:'Worker Example',email:null,phone:'+919876543210'}]};
   if(sql.includes('INSERT INTO hr.workers'))return {rowCount:1,rows:[{worker_id:'12',employee_code:'EMP-0012',designation:'Weaver',skill_stage:'WEAVING',default_shift_id:'3'}]};
   if(sql.includes('SELECT shift_name FROM master.shifts'))return {rowCount:1,rows:[{shift_name:'Day'}]};
   return {rowCount:1,rows:[]};},release(){released=true;}});
 const result=await service.createWorker('481',{fullName:'Worker Example',phone:'+91 98765 43210',skillStage:'WEAVING',designation:'Weaver',shiftId:'3'});
 const actorCall=calls.find(call=>call.sql.includes("set_config('app.current_user_id'"));assert.equal(actorCall.args[0],'481');
 const userInsert=calls.find(call=>call.sql.includes('INSERT INTO auth.users'));assert.match(userInsert.sql,/must_change_password/);assert.equal(userInsert.args[0],'6');assert.equal(userInsert.args[3],'+919876543210');
 assert.equal(result.worker.worker_id,'12');assert.equal(result.worker.email,null);assert.ok(result.temporaryPassword.length>=20);assert.equal(released,true);
});

test('QC defect failure rolls back inspection and releases its transaction client',async()=>{
 const calls=[];let released=false;pool.connect=async()=>({query:async(sql,args=[])=>{calls.push({sql,args});
   if(sql.startsWith('SELECT r.roll_id,r.current_status'))return {rowCount:1,rows:[{roll_id:'12',current_status:'PENDING_QC'}]};
   if(sql.startsWith('SELECT 1 FROM master.defect_types'))return {rowCount:1,rows:[{}]};
   if(sql.startsWith('INSERT INTO quality.inspections'))return {rowCount:1,rows:[{inspection_id:'90',inspection_no:'QC-0090',result:'REWORK',inspected_at:new Date(),reason:'Uneven weave',rework_instructions:'Reweave affected section',notes:null}]};
   if(sql.startsWith('INSERT INTO quality.inspection_defects')){const error=new Error('foreign key');error.code='23503';throw error;}
   return {rowCount:1,rows:[]};},release(){released=true;}});
 await assert.rejects(service.inspectRoll('481','12',{result:'REWORK',reason:'Uneven weave',reworkInstructions:'Reweave affected section',defects:[{defectTypeId:'2',severity:'MAJOR',count:1}]}),error=>error.status===409);
 assert.ok(calls.some(call=>call.sql==='ROLLBACK'));assert.ok(!calls.some(call=>call.sql==='COMMIT'));assert.equal(released,true);
});

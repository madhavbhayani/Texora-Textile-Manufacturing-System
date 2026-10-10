'use strict';
process.env.DATABASE_HOST ||= '127.0.0.1';
process.env.DATABASE_NAME ||= 'texora_test';
process.env.DATABASE_USER ||= 'texora_test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {pool}=require('../database/config/db');
const authorize=require('../modules/auth/middleware/authorize');
const service=require('../modules/worker/services/workerService');
const {wageConfiguration}=require('../scripts/seedDevWorker');

const originalQuery=pool.query.bind(pool),originalConnect=pool.connect.bind(pool);
test.afterEach(()=>{pool.query=originalQuery;pool.connect=originalConnect;});

test('Worker API authorization rejects every non-Worker role and temporary-password session',()=>{
  const gate=authorize('WORKER');
  for(const roleCode of ['BUYER','OWNER','STORE_MANAGER','SUPERVISOR','DISPATCH_OFFICER']){let error;gate({auth:{roleCode,mustChangePassword:false}},{},value=>{error=value;});assert.equal(error.status,403);}
  let error;gate({auth:{roleCode:'WORKER',mustChangePassword:true}},{},value=>{error=value;});assert.equal(error.code,'PASSWORD_CHANGE_REQUIRED');
});

test('Worker attendance history resolves and scopes by authenticated worker profile',async()=>{
  const calls=[];pool.query=async(sql,args)=>{calls.push({sql,args});if(sql.includes('FROM hr.workers w JOIN auth.users'))return {rowCount:1,rows:[{worker_id:'31',is_active:true,account_active:true}]};return {rowCount:0,rows:[]};};
  const result=await service.attendance('900',{limit:'10',offset:'0'});
  assert.deepEqual(result.records,[]);assert.match(calls[1].sql,/a\.worker_id=\$1/);assert.equal(calls[1].args[0],'31');assert.ok(calls[1].sql.includes('worker_id=$1'));
});

test('Worker operations derive identity and call existing assignment routine',async()=>{
  const calls=[];pool.connect=async()=>({query:async(sql,args=[])=>{calls.push({sql,args});
    if(sql.includes('FROM hr.workers w JOIN auth.users'))return {rowCount:1,rows:[{worker_id:'31',is_active:true,account_active:true}]};
    if(sql.includes('SELECT ma.machine_assignment_id,ma.job_id'))return {rowCount:1,rows:[{machine_assignment_id:'12',job_id:'6',machine_id:'4',assignment_status:'ASSIGNED',job_status:'ASSIGNED',machine_status:'IDLE'}]};
    if(sql.includes('FROM hr.attendance'))return {rowCount:1,rows:[{ok:1}]};
    if(sql.includes('SELECT ma.machine_assignment_id,ma.status'))return {rowCount:1,rows:[{machine_assignment_id:'12',assignment_status:'RUNNING',job_id:'6',job_no:'JOB-0006',job_status:'IN_PROGRESS',machine_status:'RUNNING'}]};
    return {rowCount:1,rows:[]};},release(){}});
  const result=await service.assignmentAction('900','12','start');
  assert.equal(result.assignment_status,'RUNNING');
  assert.ok(calls.some(call=>call.sql.includes("set_config('app.current_user_id'")&&call.args[0]==='900'));
  assert.ok(calls.some(call=>call.sql.includes('production.set_assignment_running($1,$2)')&&call.args[1]==='900'));
});

test('Worker seed requires explicit development wage policy',()=>{
  assert.throws(()=>wageConfiguration({}),/Set DEMO_WORKER_WAGE_TYPE/);
  assert.deepEqual(wageConfiguration({DEMO_WORKER_WAGE_TYPE:'HOURLY',DEMO_WORKER_HOURLY_RATE:'125'}),{type:'HOURLY',rate:125});
  assert.throws(()=>wageConfiguration({DEMO_WORKER_WAGE_TYPE:'DAILY',DEMO_WORKER_DAILY_RATE:'not-a-number'}),/Set DEMO_WORKER_WAGE_TYPE/);
});

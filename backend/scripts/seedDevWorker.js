'use strict';
require('dotenv').config();

const EMAIL='worker@gmail.com';
const FULL_NAME='Demo Worker';

function wageConfiguration(env=process.env) {
  const type=String(env.DEMO_WORKER_WAGE_TYPE||'').trim().toUpperCase();
  if(type==='DAILY'&&env.DEMO_WORKER_DAILY_RATE!==undefined){const rate=Number(env.DEMO_WORKER_DAILY_RATE);if(Number.isFinite(rate)&&rate>=0)return {type,rate};}
  if(type==='HOURLY'&&env.DEMO_WORKER_HOURLY_RATE!==undefined){const rate=Number(env.DEMO_WORKER_HOURLY_RATE);if(Number.isFinite(rate)&&rate>=0)return {type,rate};}
  throw new Error('Set DEMO_WORKER_WAGE_TYPE=DAILY with DEMO_WORKER_DAILY_RATE, or DEMO_WORKER_WAGE_TYPE=HOURLY with DEMO_WORKER_HOURLY_RATE. No demo wage is selected automatically.');
}

async function seedDevWorker(){
  if(process.env.NODE_ENV!=='development'||process.env.SEED_DEMO_USERS!=='true')throw new Error('Worker demo seed is disabled. Set NODE_ENV=development and SEED_DEMO_USERS=true to run it.');
  const bcrypt=require('bcryptjs');
  const {pool,closePool}=require('../database/config/db');
  try{
    await require('../database/migrator/runner').runMigrations();
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const existing=await client.query(`SELECT u.user_id,u.full_name,u.must_change_password,r.role_code
        FROM auth.users u JOIN auth.roles r USING(role_id) WHERE lower(u.email)=lower($1) FOR UPDATE OF u`,[EMAIL]);
      if(existing.rowCount){
        const user=existing.rows[0];
        if(user.role_code!=='WORKER')throw new Error(`${EMAIL} already exists with role ${user.role_code}; refusing to change the account.`);
        const worker=await client.query('SELECT worker_id FROM hr.workers WHERE user_id=$1',[user.user_id]);
        if(worker.rowCount){await client.query('COMMIT');console.info('Development Worker account and profile already exist; no changes made.');return;}
        if(user.full_name!==FULL_NAME||!user.must_change_password)throw new Error('Existing account is not an eligible temporary Demo Worker account; refusing to create a profile.');
        const wage=wageConfiguration();
        const shift=await client.query('SELECT shift_id FROM master.shifts WHERE is_active ORDER BY start_time,shift_id LIMIT 1');
        const workerValues=wage.type==='DAILY'?[wage.rate,null]:[null,wage.rate];
        await client.query(`INSERT INTO hr.workers(user_id,default_shift_id,wage_type,daily_rate,hourly_rate)
          VALUES($1,$2,$3,$4,$5)`,[user.user_id,shift.rows[0]?.shift_id||null,wage.type,...workerValues]);
        await client.query('COMMIT');console.info('Missing worker profile created for the existing temporary development account.');return;
      }
      const wage=wageConfiguration();
      const role=await client.query("SELECT role_id FROM auth.roles WHERE role_code='WORKER' AND is_active");
      if(!role.rowCount)throw new Error('Active WORKER role not found. Run database migrations first.');
      const rounds=Math.min(14,Math.max(10,Number(process.env.BCRYPT_ROUNDS||12)));
      const passwordHash=await bcrypt.hash('admin123',rounds);
      const account=await client.query(`INSERT INTO auth.users(role_id,full_name,email,password_hash,must_change_password)
        VALUES($1,$2,$3,$4,true) RETURNING user_id`,[role.rows[0].role_id,FULL_NAME,EMAIL,passwordHash]);
      const shift=await client.query('SELECT shift_id FROM master.shifts WHERE is_active ORDER BY start_time,shift_id LIMIT 1');
      const wageValues=wage.type==='DAILY'?[wage.rate,null]:[null,wage.rate];
      await client.query(`INSERT INTO hr.workers(user_id,default_shift_id,wage_type,daily_rate,hourly_rate)
        VALUES($1,$2,$3,$4,$5)`,[account.rows[0].user_id,shift.rows[0]?.shift_id||null,wage.type,...wageValues]);
      await client.query('COMMIT');
      console.info(`Development Worker ${EMAIL} created with a hashed temporary password. Change it at first sign-in.`);
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }finally{await closePool();}
}

if(require.main===module)seedDevWorker().catch(error=>{console.error(`[Worker seed] ${error.message}`);process.exitCode=1;});
module.exports={seedDevWorker,wageConfiguration};

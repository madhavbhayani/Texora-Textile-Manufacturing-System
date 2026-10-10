'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');
const { sendWorkerCredentials } = require('../../../shared/email/mailer');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

const fail = (status, code, message) => { throw new AppError(status, code, message); };
const notFound = (what) => fail(404, 'NOT_FOUND', `${what} was not found.`);
function id(value, label = 'ID') {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) fail(400, 'VALIDATION_ERROR', `${label} must be a valid ID.`);
  return String(value);
}
function reason(value, label = 'Reason') {
  const result = String(value || '').trim();
  if (result.length < 5 || result.length > 1000) fail(400, 'VALIDATION_ERROR', `${label} must be between 5 and 1000 characters.`);
  return result;
}
function dbError(error) {
  if (error instanceof AppError) throw error;
  if (['23505', '23P01'].includes(error.code)) fail(409, 'WORKFLOW_CONFLICT', 'This operation conflicts with another active production assignment or record. Refresh and try again.');
  if (['23503', '23514', '42501'].includes(error.code)) fail(error.code === '42501' ? 403 : 409, 'WORKFLOW_RULE', 'The requested operation is not allowed by the current production workflow.');
  throw error;
}
async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { try { await client.query('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; } dbError(error); }
  finally { client.release(); }
}
async function actor(client, userId) { await client.query("SELECT set_config('app.current_user_id',$1,TRUE)", [String(userId)]); }

const jobSelect = `SELECT e.*, a.machine_assignment_id, a.machine_id, m.machine_code, m.machine_name,
  a.shift_id, sh.shift_name, a.status AS assignment_status, a.started_at AS machine_started_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('worker_id',w.worker_id,'job_worker_assignment_id',jwa.job_worker_assignment_id,'employee_code',w.employee_code,'full_name',u.full_name))
    FROM production.job_worker_assignments jwa JOIN hr.workers w USING(worker_id) JOIN auth.users u USING(user_id)
    WHERE jwa.machine_assignment_id=a.machine_assignment_id AND jwa.ended_at IS NULL),'[]'::jsonb) AS workers,
  CASE WHEN EXISTS(SELECT 1 FROM inventory.material_issues mi WHERE mi.job_id=e.job_id) THEN 'ISSUED' ELSE h.status END AS handoff_status, h.handoff_no
FROM reporting.production_job_efficiency e
LEFT JOIN LATERAL (SELECT ma.* FROM production.machine_assignments ma WHERE ma.job_id=e.job_id
  AND ma.status IN ('ASSIGNED','RUNNING','PAUSED') ORDER BY ma.assigned_at DESC LIMIT 1) a ON true
LEFT JOIN master.machines m ON m.machine_id=a.machine_id
LEFT JOIN master.shifts sh ON sh.shift_id=a.shift_id
LEFT JOIN production.store_handoffs h ON h.production_job_id=e.job_id`;

async function dashboard(userId) {
  const [metrics, handoffs, jobs, machines, shifts, pendingQc, rework, inspections] = await Promise.all([
    pool.query(`SELECT
      (SELECT count(*) FROM production.store_handoffs WHERE supervisor_user_id=$1 AND status='REQUESTED') AS new_handoffs,
      (SELECT count(*) FROM production.store_handoffs WHERE supervisor_user_id=$1 AND status IN ('ACCEPTED','JOB_CREATED')) AS accepted_handoffs,
      (SELECT count(*) FROM production.jobs j JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE h.supervisor_user_id=$1 AND j.status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED')) AS active_jobs,
      (SELECT count(*) FROM production.jobs j JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE h.supervisor_user_id=$1 AND j.status='IN_PROGRESS') AS jobs_in_progress,
      (SELECT count(*) FROM production.jobs j JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE h.supervisor_user_id=$1 AND j.status='PAUSED') AS jobs_paused,
      (SELECT count(*) FROM master.machines WHERE is_active AND status='RUNNING') AS machines_running,
      (SELECT count(*) FROM master.machines WHERE is_active AND status='IDLE') AS machines_idle,
      (SELECT count(*) FROM master.machines WHERE is_active AND status IN ('BREAKDOWN','MAINTENANCE')) AS machines_unavailable,
      (SELECT COALESCE(sum(pl.good_meters),0) FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.store_handoffs h ON h.production_job_id=ma.job_id WHERE h.supervisor_user_id=$1 AND pl.logged_at::date=current_date) AS produced_today_m,
      (SELECT COALESCE(sum(pl.waste_meters),0) FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.store_handoffs h ON h.production_job_id=ma.job_id WHERE h.supervisor_user_id=$1 AND pl.logged_at::date=current_date) AS waste_today_m,
      (SELECT COALESCE(sum(r.length_meters),0) FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1 AND r.produced_at::date=current_date AND r.current_status IN('PASSED','DISPATCHED')) AS qc_passed_today_m,
      (SELECT count(*) FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1 AND r.current_status='PENDING_QC') AS pending_qc_rolls,
      (SELECT COALESCE(sum(r.length_meters),0) FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1 AND r.current_status='REWORK') AS rework_m,
      (SELECT COALESCE(sum(r.length_meters),0) FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1 AND r.current_status='REJECTED') AS rejected_m,
      (SELECT round(100.0*COALESCE(sum(r.length_meters) FILTER(WHERE r.current_status IN ('PASSED','DISPATCHED')),0)/NULLIF(sum(r.length_meters),0),2) FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1) AS qc_yield_percent`, [userId]),
    pool.query(`SELECT h.handoff_id,h.handoff_no,h.status,h.stage,h.planned_meters,h.created_at,o.order_no,b.company_name,ft.fabric_name,c.colour_name
      FROM production.store_handoffs h JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id)
      JOIN master.buyers b USING(buyer_id) JOIN master.fabric_types ft USING(fabric_type_id) LEFT JOIN master.colours c USING(colour_id)
      WHERE h.supervisor_user_id=$1 AND h.status IN ('REQUESTED','ON_HOLD','ACCEPTED','JOB_CREATED','ISSUED') ORDER BY h.created_at DESC LIMIT 8`, [userId]),
    pool.query(`${jobSelect} WHERE EXISTS(SELECT 1 FROM production.store_handoffs h WHERE h.production_job_id=e.job_id AND h.supervisor_user_id=$1)
      AND e.job_status IN ('PLANNED','ASSIGNED','IN_PROGRESS','PAUSED') ORDER BY e.job_id DESC LIMIT 8`, [userId]),
    pool.query(`SELECT m.machine_id,m.machine_code,m.machine_name,m.stage,m.status,ma.job_id,j.job_no
      FROM master.machines m LEFT JOIN production.machine_assignments ma ON ma.machine_id=m.machine_id AND ma.status IN ('ASSIGNED','RUNNING','PAUSED')
      LEFT JOIN production.jobs j ON j.job_id=ma.job_id WHERE m.is_active AND m.status IN ('BREAKDOWN','MAINTENANCE') ORDER BY m.machine_name LIMIT 8`),
    pool.query(`SELECT sh.shift_name,COALESCE(sum(pl.good_meters),0) produced_meters,COALESCE(sum(pl.waste_meters),0) waste_meters
      FROM master.shifts sh LEFT JOIN production.production_logs pl ON pl.shift_id=sh.shift_id AND pl.logged_at::date=current_date
      LEFT JOIN production.machine_assignments ma USING(machine_assignment_id)
      LEFT JOIN production.store_handoffs h ON h.production_job_id=ma.job_id AND h.supervisor_user_id=$1
      WHERE sh.is_active AND (pl.production_log_id IS NULL OR h.handoff_id IS NOT NULL) GROUP BY sh.shift_id ORDER BY sh.shift_name`, [userId]),
    pool.query(`SELECT r.roll_id,r.roll_no,r.length_meters,r.current_status,e.job_no,e.order_no,e.fabric_name,e.colour_name FROM production.rolls r
      JOIN reporting.production_job_efficiency e USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=r.job_id
      WHERE h.supervisor_user_id=$1 AND r.current_status='PENDING_QC' ORDER BY r.produced_at LIMIT 8`, [userId]),
    pool.query(`SELECT r.roll_id,r.roll_no,r.length_meters,i.result,i.reason,i.rework_instructions,i.inspected_at,e.job_no,e.order_no FROM production.rolls r
      JOIN production.store_handoffs h ON h.production_job_id=r.job_id JOIN LATERAL(SELECT * FROM quality.inspections qi WHERE qi.roll_id=r.roll_id ORDER BY qi.inspected_at DESC,qi.inspection_id DESC LIMIT 1)i ON true
      JOIN reporting.production_job_efficiency e USING(job_id) WHERE h.supervisor_user_id=$1 AND i.result='REWORK' ORDER BY i.inspected_at DESC LIMIT 8`, [userId]),
    pool.query(`SELECT i.inspection_id,i.inspection_no,i.result,i.inspected_at,r.roll_no,e.job_no FROM quality.inspections i JOIN production.rolls r USING(roll_id)
      JOIN reporting.production_job_efficiency e USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=r.job_id
      WHERE h.supervisor_user_id=$1 ORDER BY i.inspected_at DESC LIMIT 8`, [userId]),
  ]);
  return { metrics: metrics.rows[0], handoffs: handoffs.rows, activeJobs: jobs.rows, breakdowns: machines.rows, shiftOutput: shifts.rows, pendingQc: pendingQc.rows, rework: rework.rows, recentInspections: inspections.rows };
}

async function handoffs(userId, query = {}) {
  const params = [userId]; const where = ['h.supervisor_user_id=$1'];
  if (query.status) { params.push(String(query.status)); where.push(`h.status=$${params.length}`); }
  params.push(Math.min(Math.max(Number(query.limit)||50,1),100), Math.max(Number(query.offset)||0,0));
  return (await pool.query(`SELECT h.*,o.order_no,o.status AS order_status,b.company_name,oi.quantity_m,oi.colour_id,ft.fabric_name,c.colour_name,j.job_no,
      creator.full_name AS created_by_name,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('yarn_type_id',hm.yarn_type_id,'yarn_name',yt.yarn_name,'required_kg',hm.required_kg,'reserved_kg',hm.reserved_kg,'issued_kg',hm.issued_kg))
        FROM production.store_handoff_materials hm JOIN master.yarn_types yt USING(yarn_type_id) WHERE hm.handoff_id=h.handoff_id),'[]'::jsonb) materials
    FROM production.store_handoffs h JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id) JOIN master.buyers b USING(buyer_id)
    JOIN master.fabric_types ft USING(fabric_type_id) LEFT JOIN master.colours c USING(colour_id) JOIN auth.users creator ON creator.user_id=h.created_by
    LEFT JOIN production.jobs j ON j.job_id=h.production_job_id WHERE ${where.join(' AND ')} ORDER BY h.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params)).rows;
}
async function handoff(userId, handoffId) {
  const result = await pool.query(`SELECT h.*,o.order_no,o.status AS order_status,b.company_name,oi.quantity_m,oi.colour_id,ft.fabric_name,c.colour_name,j.job_no,creator.full_name AS created_by_name
    FROM production.store_handoffs h JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id) JOIN master.buyers b USING(buyer_id)
    JOIN master.fabric_types ft USING(fabric_type_id) LEFT JOIN master.colours c USING(colour_id) LEFT JOIN production.jobs j ON j.job_id=h.production_job_id
    JOIN auth.users creator ON creator.user_id=h.created_by WHERE h.handoff_id=$1 AND h.supervisor_user_id=$2`, [id(handoffId,'Handoff'), userId]);
  if (!result.rowCount) notFound('Handoff');
  const materials = await pool.query(`SELECT hm.*,yt.yarn_name FROM production.store_handoff_materials hm JOIN master.yarn_types yt USING(yarn_type_id) WHERE hm.handoff_id=$1`, [handoffId]);
  const history = await pool.query(`SELECT hh.*,u.full_name AS changed_by_name FROM production.store_handoff_history hh LEFT JOIN auth.users u ON u.user_id=hh.changed_by WHERE hh.handoff_id=$1 ORDER BY hh.changed_at,hh.history_id`, [handoffId]);
  return { ...result.rows[0], materials: materials.rows, history: history.rows };
}
async function transitionHandoff(userId, handoffId, nextStatus, note) {
  return transaction(async (client) => {
    await actor(client,userId);
    const h = await client.query(`SELECT h.*,o.status AS order_status FROM production.store_handoffs h JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id)
      WHERE h.handoff_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF h,o`, [id(handoffId,'Handoff'),userId]);
    if (!h.rowCount) notFound('Handoff');
    const current = h.rows[0];
    if (!['REQUESTED','ON_HOLD'].includes(current.status)) fail(409,'INVALID_HANDOFF_STATE',`A ${current.status} handoff cannot be changed to ${nextStatus}.`);
    if (['CANCELLED','DELIVERED'].includes(current.order_status)) fail(409,'ORDER_NOT_ACTIVE','The linked customer order is no longer active.');
    if (nextStatus !== 'ACCEPTED') {
      const ref=`Production handoff ${current.handoff_no}`;
      await client.query(`UPDATE inventory.yarn_reservations SET status='RELEASED',released_at=now() WHERE order_item_id=$1 AND status='ACTIVE' AND notes=$2`,[current.order_item_id,ref]);
      await client.query(`UPDATE production.store_handoff_materials SET reserved_kg=0 WHERE handoff_id=$1`,[handoffId]);
    }
    const updated = await client.query(`UPDATE production.store_handoffs SET status=$2,accepted_at=CASE WHEN $2='ACCEPTED' THEN now() ELSE accepted_at END,
      notes=CASE WHEN $3::text IS NULL THEN notes ELSE concat_ws(E'\n',NULLIF(notes,''),$3) END WHERE handoff_id=$1 RETURNING handoff_id,handoff_no,status,accepted_at,notes`, [handoffId,nextStatus,note||null]);
    if (nextStatus !== 'ACCEPTED') await client.query(`INSERT INTO notification.user_notifications(recipient_user_id,category,title,message,entity_type,entity_id)
      SELECT h.created_by,'PRODUCTION',$2,$3,'STORE_HANDOFF',$1 FROM production.store_handoffs h WHERE h.handoff_id=$1`, [handoffId,`Handoff ${nextStatus.toLowerCase().replace('_',' ')}`,`Handoff ${current.handoff_no} was ${nextStatus.toLowerCase().replace('_',' ')}. ${note}`]);
    return updated.rows[0];
  });
}
async function createJob(userId,handoffId) {
  return transaction(async(client)=>{
    await actor(client,userId);
    const h=await client.query(`SELECT h.*,oi.fabric_type_id,o.status AS order_status FROM production.store_handoffs h JOIN sales.order_items oi USING(order_item_id) JOIN sales.orders o USING(order_id)
      WHERE h.handoff_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF h,o`,[id(handoffId,'Handoff'),userId]);
    if(!h.rowCount)notFound('Handoff'); const row=h.rows[0];
    if(row.status!=='ACCEPTED'||row.production_job_id)fail(409,'HANDOFF_NOT_READY','Only an accepted handoff without a linked job can create a production job.');
    if(['CANCELLED','DELIVERED'].includes(row.order_status))fail(409,'ORDER_NOT_ACTIVE','The linked customer order is no longer active.');
    const existing=await client.query(`SELECT job_id FROM production.jobs WHERE order_item_id=$1 AND status<>'CANCELLED' AND job_id IN(SELECT production_job_id FROM production.store_handoffs WHERE order_item_id=$1 AND status NOT IN('REJECTED','CANCELLED'))`,[row.order_item_id]);
    if(existing.rowCount)fail(409,'HANDOFF_JOB_EXISTS','This handoff already has a production job.');
    const job=await client.query(`INSERT INTO production.jobs(order_item_id,stage,planned_meters,created_by) VALUES($1,$2,$3,$4) RETURNING job_id,job_no,status`,[row.order_item_id,row.stage,row.planned_meters,userId]);
    await client.query(`UPDATE production.store_handoffs SET production_job_id=$2,status='JOB_CREATED' WHERE handoff_id=$1`,[handoffId,job.rows[0].job_id]);
    await client.query(`INSERT INTO notification.user_notifications(recipient_user_id,category,title,message,entity_type,entity_id) VALUES($1,'PRODUCTION',$2,$3,'PRODUCTION_JOB',$4)`,[row.created_by,'Production job created',`Job ${job.rows[0].job_no} was created for handoff ${row.handoff_no}.`,job.rows[0].job_id]);
    return {...job.rows[0],handoff_no:row.handoff_no};
  });
}

async function jobs(userId,query={}) {
  const params=[userId]; const where=[`EXISTS(SELECT 1 FROM production.store_handoffs h WHERE h.production_job_id=e.job_id AND h.supervisor_user_id=$1)`];
  if(query.status){params.push(query.status);where.push(`e.job_status=$${params.length}`);} if(query.stage){params.push(query.stage);where.push(`e.stage=$${params.length}`);} if(query.search){params.push(`%${String(query.search).slice(0,100)}%`);where.push(`(e.job_no ILIKE $${params.length} OR e.order_no ILIKE $${params.length} OR e.fabric_name ILIKE $${params.length})`);}
  params.push(Math.min(Math.max(Number(query.limit)||50,1),100),Math.max(Number(query.offset)||0,0));
  return (await pool.query(`${jobSelect} WHERE ${where.join(' AND ')} ORDER BY e.job_id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows;
}
async function job(userId,jobId) {
  const result=await pool.query(`${jobSelect} WHERE e.job_id=$1 AND EXISTS(SELECT 1 FROM production.store_handoffs h WHERE h.production_job_id=e.job_id AND h.supervisor_user_id=$2)`,[id(jobId,'Job'),userId]);
  if(!result.rowCount)notFound('Production job');
  const [logs,rolls,materials,replacementRequests]=await Promise.all([
    pool.query(`SELECT pl.*,w.employee_code,u.full_name AS worker_name,sh.shift_name,m.machine_name FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN hr.workers w USING(worker_id) JOIN auth.users u USING(user_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id JOIN master.machines m USING(machine_id) WHERE ma.job_id=$1 ORDER BY pl.logged_at DESC`,[jobId]),
    pool.query(`SELECT r.*,l.machine_assignment_id,i.inspection_no,i.result AS latest_inspection,i.reason AS inspection_reason FROM production.rolls r LEFT JOIN production.production_logs l ON l.production_log_id=r.production_log_id LEFT JOIN LATERAL(SELECT * FROM quality.inspections qi WHERE qi.roll_id=r.roll_id ORDER BY qi.inspected_at DESC,qi.inspection_id DESC LIMIT 1)i ON true WHERE r.job_id=$1 ORDER BY r.produced_at DESC`,[jobId]),
    pool.query(`SELECT mi.material_issue_id,mi.issue_no,mi.issued_at,y.yarn_name,mii.quantity_kg FROM inventory.material_issues mi JOIN inventory.material_issue_items mii USING(material_issue_id) JOIN inventory.yarn_lots yl USING(yarn_lot_id) JOIN master.yarn_types y USING(yarn_type_id) WHERE mi.job_id=$1 ORDER BY mi.issued_at DESC`,[jobId]),
    pool.query(`SELECT q.replacement_request_id,q.request_no,q.status,q.rejected_roll_id,r.roll_no,r.length_meters,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('yarn_type_id',i.yarn_type_id,'yarn_name',yt.yarn_name,'required_kg',i.required_kg) ORDER BY yt.yarn_name)
          FROM production.replacement_material_request_items i JOIN master.yarn_types yt USING(yarn_type_id)
          WHERE i.replacement_request_id=q.replacement_request_id),'[]'::jsonb) materials
      FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id
      WHERE q.job_id=$1 ORDER BY q.requested_at DESC`,[jobId]),
  ]);
  return {...result.rows[0],logs:logs.rows,rolls:rolls.rows,materials:materials.rows,replacementRequests:replacementRequests.rows};
}
async function assignMachine(userId,jobId,input) {
 return transaction(async(client)=>{
   await actor(client,userId);
   const j=await client.query(`SELECT j.*,h.status AS handoff_status FROM production.jobs j JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE j.job_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF j,h`,[id(jobId,'Job'),userId]);
   if(!j.rowCount)notFound('Production job');
   const rework=await client.query(`SELECT count(*)::integer AS roll_count,COALESCE(sum(length_meters),0) AS rework_meters
     FROM production.rolls WHERE job_id=$1 AND current_status='REWORK'`,[jobId]);
   const openReplacement=await client.query(`SELECT count(*)::integer AS count FROM production.replacement_material_requests WHERE job_id=$1 AND status IN('PENDING','ISSUED')`,[jobId]);
   let replacement=null;
   if(input.replacementRequestId){
     const request=await client.query(`SELECT q.replacement_request_id,q.request_no,q.status,q.job_id,r.current_status AS roll_status,r.length_meters
       FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id
       WHERE q.replacement_request_id=$1 AND q.job_id=$2 FOR UPDATE OF q`,[id(input.replacementRequestId,'Replacement request'),jobId]);
     if(!request.rowCount)notFound('Replacement material request');
     replacement=request.rows[0];
     if(replacement.status!=='ISSUED'||replacement.roll_status!=='REJECTED')fail(409,'REPLACEMENT_MATERIALS_NOT_ISSUED','The Store Manager must approve and issue replacement materials before production is assigned.');
   }
   if(Number(openReplacement.rows[0].count)>0&&!replacement)fail(409,'REPLACEMENT_REQUEST_REQUIRED','Select an approved rejected-roll material request before assigning this production.');
   const isRework=!replacement&&Number(rework.rows[0].roll_count)>0;
   let selectedReworkRolls=[];
   if(isRework){
     const requested=Array.isArray(input.reworkRollIds)?[...new Set(input.reworkRollIds.map(value=>id(value,'Rework roll')))]:[];
     if(!requested.length)fail(400,'REWORK_ROLLS_REQUIRED','Select the rework rolls for this machine assignment.');
     if(requested.length>100)fail(400,'REWORK_ROLLS_LIMIT','An assignment can include up to 100 rework rolls.');
     const selected=await client.query(`SELECT r.roll_id,r.length_meters,
         (SELECT qi.inspection_id FROM quality.inspections qi WHERE qi.roll_id=r.roll_id ORDER BY qi.inspected_at DESC,qi.inspection_id DESC LIMIT 1) AS source_inspection_id
       FROM production.rolls r WHERE r.job_id=$1 AND r.current_status='REWORK' AND r.roll_id=ANY($2::bigint[])
       ORDER BY r.roll_id FOR UPDATE`,[jobId,requested]);
     if(selected.rowCount!==requested.length)fail(409,'REWORK_ROLLS_CHANGED','One or more selected rolls are no longer awaiting rework. Refresh the job and select again.');
     selectedReworkRolls=selected.rows;
   }
   const materialIssue=await client.query(`SELECT EXISTS(SELECT 1 FROM inventory.material_issues WHERE job_id=$1) AS issued`,[jobId]);
   if(!materialIssue.rows[0].issued)fail(409,'MATERIALS_NOT_ISSUED','The Store Manager must issue the reserved materials before assigning production machinery.');
   if(!['PLANNED','ASSIGNED','PAUSED'].includes(j.rows[0].status)&&!(j.rows[0].status==='COMPLETED'&&(isRework||replacement)))fail(409,'INVALID_JOB_STATE','Only an open job or a completed job with an approved rework or replacement request can be assigned.');
   const machine=await client.query(`SELECT machine_id,stage,status FROM master.machines WHERE machine_id=$1 AND is_active FOR UPDATE`,[id(input.machineId,'Machine')]);
   if(!machine.rowCount)notFound('Active machine'); if(machine.rows[0].stage!==j.rows[0].stage)fail(400,'MACHINE_STAGE_MISMATCH','The selected machine is configured for a different production stage.');
   if(['BREAKDOWN','MAINTENANCE'].includes(machine.rows[0].status))fail(409,'MACHINE_UNAVAILABLE',`The machine is currently ${machine.rows[0].status.toLowerCase()}.`);
   const shift=await client.query(`SELECT shift_id FROM master.shifts WHERE shift_id=$1 AND is_active`,[id(input.shiftId,'Shift')]); if(!shift.rowCount)notFound('Active shift');
   const note=String(input.notes||'').trim().slice(0,450);
   const reworkTarget=selectedReworkRolls.reduce((sum,roll)=>sum+Number(roll.length_meters),0);
   const assignmentNotes=replacement?`REPLACEMENT: ${replacement.request_no}${note?` · ${note}`:''}`:isRework?`REWORK: ${note||`${selectedReworkRolls.length} selected roll(s), ${reworkTarget} m`}`:note||null;
   const result=await client.query(`INSERT INTO production.machine_assignments(job_id,machine_id,shift_id,assigned_by,notes,replacement_request_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING machine_assignment_id,status,assigned_at,notes,replacement_request_id`,[jobId,machine.rows[0].machine_id,shift.rows[0].shift_id,userId,assignmentNotes,replacement?.replacement_request_id||null]);
   for(const roll of selectedReworkRolls)await client.query(`INSERT INTO production.machine_assignment_rework_rolls(machine_assignment_id,roll_id,source_inspection_id,assigned_by) VALUES($1,$2,$3,$4)`,[result.rows[0].machine_assignment_id,roll.roll_id,roll.source_inspection_id,userId]);
   let carriedWorkers=0;
   if(isRework&&!replacement){
     const reassigned=await client.query(`INSERT INTO production.job_worker_assignments(machine_assignment_id,worker_id,assigned_by,notes)
       SELECT $1,previous.worker_id,$2,'Automatically reassigned for quality rework'
       FROM (
         SELECT DISTINCT ON (jwa.worker_id) jwa.worker_id,jwa.ended_at,jwa.unassigned_at
         FROM production.job_worker_assignments jwa
         JOIN production.machine_assignments previous_ma ON previous_ma.machine_assignment_id=jwa.machine_assignment_id
         JOIN hr.workers w ON w.worker_id=jwa.worker_id AND w.is_active
         JOIN auth.users au ON au.user_id=w.user_id AND au.is_active
         WHERE previous_ma.job_id=$3 AND (w.skill_stage IS NULL OR w.skill_stage=$4)
         ORDER BY jwa.worker_id,previous_ma.assigned_at DESC,jwa.assigned_at DESC
       ) previous
       WHERE previous.ended_at IS NOT NULL AND previous.unassigned_at IS NULL
         AND NOT EXISTS (
         SELECT 1 FROM production.job_worker_assignments active
         WHERE active.worker_id=previous.worker_id AND active.ended_at IS NULL AND active.unassigned_at IS NULL
       )
       RETURNING worker_id`,[result.rows[0].machine_assignment_id,userId,jobId,j.rows[0].stage]);
     carriedWorkers=reassigned.rowCount;
   }
   await client.query(`UPDATE production.jobs SET status='ASSIGNED',completed_at=NULL WHERE job_id=$1 AND status IN('PLANNED','PAUSED','COMPLETED')`,[jobId]); return {...result.rows[0],is_rework:isRework,rework_roll_count:rework.rows[0].roll_count,rework_meters:rework.rows[0].rework_meters,reassigned_worker_count:carriedWorkers,replacement_request:replacement||null};
 });
}

async function workers(stage) {
 return (await pool.query(`SELECT w.worker_id,w.employee_code,w.designation,w.skill_stage,w.default_shift_id,s.shift_name AS default_shift_name,u.full_name,u.email,u.phone,
   EXISTS(SELECT 1 FROM production.job_worker_assignments a WHERE a.worker_id=w.worker_id AND a.ended_at IS NULL) AS assigned
   FROM hr.workers w JOIN auth.users u USING(user_id) JOIN auth.roles r USING(role_id) LEFT JOIN master.shifts s ON s.shift_id=w.default_shift_id
   WHERE w.is_active AND u.is_active AND r.role_code='WORKER' AND r.is_active AND ($1::text IS NULL OR w.skill_stage IS NULL OR w.skill_stage=$1)
   ORDER BY w.employee_code`,[stage||null])).rows;
}
async function shifts() { return (await pool.query(`SELECT shift_id,shift_name,start_time,end_time FROM master.shifts WHERE is_active ORDER BY start_time`)).rows; }
async function createWorker(userId,input) {
 const fullName=String(input.fullName||'').trim(),email=String(input.email||'').trim().toLowerCase()||null;
 const phone=String(input.phone||'').trim().replace(/[\s().-]/g,'')||null;
 const designation=String(input.designation||'').trim(),stage=String(input.skillStage||'').trim().toUpperCase()||null;
 const designations=['Machine Operator','Weaver','Spinner','Dyeing Operator','Quality Inspector','Production Helper'];
 if(fullName.length<2||fullName.length>160)fail(400,'VALIDATION_ERROR','Worker name must be between 2 and 160 characters.');
 if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)fail(400,'VALIDATION_ERROR','Enter a valid worker email address.');
 if(!phone||!/^\+?\d{10,15}$/.test(phone))fail(400,'VALIDATION_ERROR','Enter a phone number with 10 to 15 digits, with an optional leading +.');
 if(!designations.includes(designation))fail(400,'VALIDATION_ERROR','Choose a valid worker designation.');
 if(stage&&!['SPINNING','WEAVING','DYEING'].includes(stage))fail(400,'VALIDATION_ERROR','Choose a valid production skill stage.');
 const shiftId=id(input.shiftId,'Shift');
 const passwordAlphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
 const temporaryPassword=Array.from({length:8},()=>passwordAlphabet[crypto.randomInt(passwordAlphabet.length)]).join('');
 const passwordHash=await bcrypt.hash(temporaryPassword,Math.min(14,Math.max(10,Number(process.env.BCRYPT_ROUNDS||12))));
 const worker=await transaction(async(client)=>{
  await actor(client,userId);
  const shift=await client.query(`SELECT shift_id FROM master.shifts WHERE shift_id=$1 AND is_active`,[shiftId]);
  if(!shift.rowCount)notFound('Active shift');
  const duplicate=await client.query(`SELECT 1 FROM auth.users WHERE ($1::text IS NOT NULL AND lower(email)=lower($1)) OR ($2::text IS NOT NULL AND phone=$2) LIMIT 1`,[email,phone]);
  if(duplicate.rowCount)fail(409,'WORKER_ACCOUNT_EXISTS','An account with that email address or phone number already exists.');
  const role=await client.query(`SELECT role_id FROM auth.roles WHERE role_code='WORKER' AND is_active`);
  if(!role.rowCount)fail(503,'WORKER_ROLE_UNAVAILABLE','Worker account provisioning is not available.');
  const account=await client.query(`INSERT INTO auth.users(role_id,full_name,email,phone,password_hash,must_change_password,created_by) VALUES($1,$2,$3,$4,$5,true,$6) RETURNING user_id,full_name,email,phone`,[role.rows[0].role_id,fullName,email,phone,passwordHash,userId]);
  const result=await client.query(`INSERT INTO hr.workers(user_id,designation,skill_stage,default_shift_id,wage_type,daily_rate) VALUES($1,$2,$3,$4,'DAILY',0) RETURNING worker_id,employee_code,designation,skill_stage,default_shift_id`,[account.rows[0].user_id,designation,stage,shift.rows[0].shift_id]);
  const worker={...result.rows[0],...account.rows[0],shift_name:(await client.query(`SELECT shift_name FROM master.shifts WHERE shift_id=$1`,[shiftId])).rows[0].shift_name};
  await sendWorkerCredentials({to:email,fullName,employeeCode:worker.employee_code,temporaryPassword});
  return worker;
 });
 return {worker,emailSent:true};
}
async function updateWorkerShift(userId,workerId,shiftId) {
 return transaction(async(client)=>{await actor(client,userId);const shift=await client.query(`SELECT shift_id,shift_name FROM master.shifts WHERE shift_id=$1 AND is_active`,[id(shiftId,'Shift')]);if(!shift.rowCount)notFound('Active shift');const result=await client.query(`UPDATE hr.workers SET default_shift_id=$2 WHERE worker_id=$1 AND is_active RETURNING worker_id,employee_code,default_shift_id`,[id(workerId,'Worker'),shift.rows[0].shift_id]);if(!result.rowCount)notFound('Active worker');return {...result.rows[0],shift_name:shift.rows[0].shift_name};});
}
async function assignWorker(userId,assignmentId,workerId,notes='') {
 return transaction(async(client)=>{
  await actor(client,userId);
  const assignment=await client.query(`SELECT ma.*,j.stage,h.status AS handoff_status FROM production.machine_assignments ma JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id
    WHERE ma.machine_assignment_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF ma,j,h`,[id(assignmentId,'Machine assignment'),userId]);
  if(!assignment.rowCount)notFound('Machine assignment'); if(!['ASSIGNED','PAUSED'].includes(assignment.rows[0].status))fail(409,'ASSIGNMENT_NOT_OPEN','Workers can only be assigned to an assigned or paused machine job.');
  const worker=await client.query(`SELECT w.worker_id FROM hr.workers w JOIN auth.users u USING(user_id) JOIN auth.roles r USING(role_id) WHERE w.worker_id=$1 AND w.is_active AND u.is_active AND r.role_code='WORKER' AND r.is_active AND (w.skill_stage IS NULL OR w.skill_stage=$2)`,[id(workerId,'Worker'),assignment.rows[0].stage]);
  if(!worker.rowCount)fail(400,'INVALID_WORKER','Choose an active worker with a compatible role and production skill.');
  return (await client.query(`INSERT INTO production.job_worker_assignments(machine_assignment_id,worker_id,assigned_by,notes) VALUES($1,$2,$3,$4) RETURNING job_worker_assignment_id,worker_id,assigned_at`,[assignmentId,worker.rows[0].worker_id,userId,String(notes||'').slice(0,500)||null])).rows[0];
 });
}
async function unassignWorker(userId,workerAssignmentId) {
 return transaction(async(client)=>{
  await actor(client,userId);
  const a=await client.query(`SELECT jwa.*,ma.status AS machine_assignment_status,j.job_id,h.supervisor_user_id FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE jwa.job_worker_assignment_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF jwa,ma`,[id(workerAssignmentId,'Worker assignment'),userId]);
  if(!a.rowCount)notFound('Active worker assignment'); if(a.rows[0].ended_at)fail(409,'WORKER_NOT_ASSIGNED','This worker assignment has already ended.');
  if(a.rows[0].machine_assignment_status==='RUNNING')fail(409,'MACHINE_RUNNING','Pause or stop the running machine through the authorized worker workflow before unassigning this worker.');
  return (await client.query(`UPDATE production.job_worker_assignments SET ended_at=now(),unassigned_at=now() WHERE job_worker_assignment_id=$1 AND ended_at IS NULL RETURNING job_worker_assignment_id,ended_at,unassigned_at`,[workerAssignmentId])).rows[0];
 });
}

async function machines() {
 return (await pool.query(`SELECT m.machine_id,m.machine_code,m.machine_name,m.stage,m.status,m.location,m.capacity_per_hour,
  ma.machine_assignment_id,ma.status AS assignment_status,ma.assigned_at,ma.started_at AS assignment_started_at,sh.shift_name,
  j.job_id,j.job_no,j.status AS job_status,e.order_no,e.company_name,e.fabric_name,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('worker_id',w.worker_id,'job_worker_assignment_id',jwa.job_worker_assignment_id,'name',u.full_name,'employee_code',w.employee_code)) FROM production.job_worker_assignments jwa JOIN hr.workers w USING(worker_id) JOIN auth.users u USING(user_id) WHERE jwa.machine_assignment_id=ma.machine_assignment_id AND jwa.ended_at IS NULL),'[]'::jsonb) workers,
  COALESCE((SELECT sum(pl.good_meters) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id AND pl.logged_at::date=current_date),0) produced_today_m,
  COALESCE((SELECT sum(pl.waste_meters) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id AND pl.logged_at::date=current_date),0) waste_today_m,
  COALESCE((SELECT sum(pl.downtime_minutes) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id AND pl.logged_at::date=current_date),0) downtime_today_min,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('old_status',ev.old_status,'new_status',ev.new_status,'reason',ev.reason,'started_at',ev.started_at,'ended_at',ev.ended_at) ORDER BY ev.started_at DESC) FROM production.machine_status_events ev WHERE ev.machine_id=m.machine_id),'[]'::jsonb) status_history
  FROM master.machines m LEFT JOIN production.machine_assignments ma ON ma.machine_id=m.machine_id AND ma.status IN('ASSIGNED','RUNNING','PAUSED')
  LEFT JOIN production.jobs j ON j.job_id=ma.job_id LEFT JOIN master.shifts sh ON sh.shift_id=ma.shift_id LEFT JOIN reporting.production_job_efficiency e ON e.job_id=j.job_id
  WHERE m.is_active ORDER BY m.machine_code`)).rows;
}
async function createMachine(userId,input) {
 const name=String(input.machineName||'').trim();
 const stage=String(input.stage||'').trim().toUpperCase();
 const location=String(input.location||'').trim();
 const capacity=input.capacityPerHour==null||input.capacityPerHour===''?null:Number(input.capacityPerHour);
 const commissionedOn=String(input.commissionedOn||'').trim()||null;
 if(name.length<2||name.length>120)fail(400,'VALIDATION_ERROR','Machine name must be between 2 and 120 characters.');
 if(!['SPINNING','WEAVING','DYEING'].includes(stage))fail(400,'VALIDATION_ERROR','Choose a valid production stage.');
 if(location.length>160)fail(400,'VALIDATION_ERROR','Location must be at most 160 characters.');
 if(capacity===null||!Number.isFinite(capacity)||capacity<=0)fail(400,'VALIDATION_ERROR','Capacity per hour is required and must be greater than zero.');
 if(commissionedOn&&!/^\d{4}-\d{2}-\d{2}$/.test(commissionedOn))fail(400,'VALIDATION_ERROR','Commissioned date must use YYYY-MM-DD.');
 return transaction(async(client)=>{
  await actor(client,userId);
  const result=await client.query(`INSERT INTO master.machines(machine_name,stage,capacity_per_hour,location,commissioned_on) VALUES($1,$2,$3,$4,$5) RETURNING machine_id,machine_code,machine_name,stage,status,capacity_per_hour,location,commissioned_on,created_at`,[name,stage,capacity,location||null,commissionedOn]);
  return result.rows[0];
 });
}
async function machine(machineId) {
 const found=await pool.query(`SELECT m.* FROM master.machines m WHERE m.machine_id=$1 AND m.is_active`,[id(machineId,'Machine')]); if(!found.rowCount)notFound('Machine');
 const [history,assignments]=await Promise.all([machineHistory(machineId),pool.query(`SELECT ma.*,j.job_no,j.stage,j.planned_meters FROM production.machine_assignments ma JOIN production.jobs j USING(job_id) WHERE ma.machine_id=$1 ORDER BY ma.assigned_at DESC LIMIT 20`,[machineId])]);
 return {...found.rows[0],history,assignments:assignments.rows};
}
async function machineHistory(machineId) { return (await pool.query(`SELECT e.*,u.full_name AS reported_by_name FROM production.machine_status_events e LEFT JOIN auth.users u ON u.user_id=e.reported_by WHERE e.machine_id=$1 ORDER BY e.started_at DESC LIMIT 50`,[id(machineId,'Machine')])).rows; }
async function statusEvent(userId,machineId,input) {
 const status=String(input.status||''); if(!['IDLE','BREAKDOWN','MAINTENANCE'].includes(status))fail(400,'VALIDATION_ERROR','Supervisors may record IDLE, BREAKDOWN, or MAINTENANCE. A worker assignment controls RUNNING status.');
 const why=reason(input.reason,'Status reason');
 return transaction(async(client)=>{await actor(client,userId);const m=await client.query(`SELECT machine_id,status FROM master.machines WHERE machine_id=$1 AND is_active FOR UPDATE`,[id(machineId,'Machine')]);if(!m.rowCount)notFound('Active machine');if(m.rows[0].status===status)fail(409,'MACHINE_ALREADY_IN_STATUS',`Machine is already ${status.toLowerCase()}.`);if(status==='IDLE'&&m.rows[0].status==='RUNNING')fail(409,'MACHINE_RUNNING','Stop the running assignment through its authorized worker workflow before setting this machine idle.');
 const event=await client.query(`INSERT INTO production.machine_status_events(machine_id,new_status,reason,reported_by) VALUES($1,$2,$3,$4) RETURNING machine_status_event_id,old_status,new_status,reason,started_at,ended_at`,[machineId,status,why,userId]);
 if(['BREAKDOWN','MAINTENANCE'].includes(status)){await client.query(`INSERT INTO notification.user_notifications(recipient_role_code,category,title,message,entity_type,entity_id) SELECT 'STORE_MANAGER','PRODUCTION','Machine unavailable',$1,'MACHINE',$2`,[`Machine ${m.rows[0].machine_id} was reported ${status.toLowerCase()}: ${why}`,machineId]);}
 return event.rows[0];});
}
async function breakdowns() {return (await pool.query(`SELECT m.machine_id,m.machine_code,m.machine_name,m.stage,m.status,e.machine_status_event_id,e.reason,e.started_at,e.reported_by,u.full_name AS reported_by_name,j.job_no,e2.order_no,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('worker_id',w.worker_id,'name',au.full_name)) FROM production.job_worker_assignments jwa JOIN hr.workers w USING(worker_id) JOIN auth.users au USING(user_id) WHERE jwa.machine_assignment_id=ma.machine_assignment_id AND jwa.ended_at IS NULL),'[]'::jsonb) workers
  FROM master.machines m JOIN LATERAL(SELECT * FROM production.machine_status_events x WHERE x.machine_id=m.machine_id AND x.ended_at IS NULL ORDER BY x.started_at DESC LIMIT 1)e ON true
  LEFT JOIN production.machine_assignments ma ON ma.machine_id=m.machine_id AND ma.status IN('ASSIGNED','RUNNING','PAUSED') LEFT JOIN production.jobs j ON j.job_id=ma.job_id LEFT JOIN reporting.production_job_efficiency e2 ON e2.job_id=j.job_id LEFT JOIN auth.users u ON u.user_id=e.reported_by
  WHERE m.status IN('BREAKDOWN','MAINTENANCE') ORDER BY e.started_at DESC`)).rows;}
async function logs(userId,jobId) { const result=await pool.query(`SELECT pl.*,w.employee_code,u.full_name AS worker_name,ma.machine_id,m.machine_name,sh.shift_name FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id JOIN hr.workers w USING(worker_id) JOIN auth.users u USING(user_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id WHERE j.job_id=$1 AND h.supervisor_user_id=$2 ORDER BY pl.logged_at DESC`,[id(jobId,'Job'),userId]);return result.rows; }

async function rolls(userId,query={}) {
 const states=query.state==='rework'?['REWORK']:query.state==='rejected'?['REJECTED']:query.state==='pending'?['PENDING_QC','REWORK']:['PENDING_QC','REWORK','PASSED','REJECTED'];
 return (await pool.query(`SELECT r.roll_id,r.roll_no,r.label_qr_value,r.length_meters,r.weight_kg,r.current_status,r.produced_at,j.job_id,j.job_no,j.stage,o.order_no,b.company_name,ft.fabric_name,ft.gsm,ft.width_inch,c.colour_name,m.machine_name,sh.shift_name,w.employee_code,wu.full_name AS worker_name,
  latest.inspection_id,latest.inspection_no,latest.result AS latest_result,latest.reason,latest.rework_instructions,latest.inspected_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('defect_name',d.defect_name,'severity',x.severity,'defect_count',x.defect_count,'notes',x.notes)) FROM quality.inspection_defects x JOIN master.defect_types d USING(defect_type_id) WHERE x.inspection_id=latest.inspection_id),'[]'::jsonb) defects
  FROM production.rolls r JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id JOIN sales.order_items oi ON oi.order_item_id=r.order_item_id JOIN sales.orders o USING(order_id) JOIN master.buyers b USING(buyer_id) JOIN master.fabric_types ft USING(fabric_type_id) LEFT JOIN master.colours c USING(colour_id) LEFT JOIN production.production_logs pl ON pl.production_log_id=r.production_log_id LEFT JOIN production.machine_assignments ma ON ma.machine_assignment_id=pl.machine_assignment_id LEFT JOIN master.machines m ON m.machine_id=COALESCE(r.machine_id,ma.machine_id) LEFT JOIN master.shifts sh ON sh.shift_id=r.shift_id LEFT JOIN hr.workers w ON w.worker_id=r.produced_by_worker_id LEFT JOIN auth.users wu ON wu.user_id=w.user_id
  LEFT JOIN LATERAL(SELECT qi.* FROM quality.inspections qi WHERE qi.roll_id=r.roll_id ORDER BY qi.inspected_at DESC,qi.inspection_id DESC LIMIT 1)latest ON true
  WHERE h.supervisor_user_id=$1 AND r.current_status=ANY($2::text[]) ORDER BY r.produced_at DESC LIMIT $3 OFFSET $4`,[userId,states,Math.min(Math.max(Number(query.limit)||50,1),100),Math.max(Number(query.offset)||0,0)])).rows;
}
async function createRoll(userId,input) {
 const length=Number(input.lengthMeters), weight=input.weightKg==null||input.weightKg===''?null:Number(input.weightKg); if(!Number.isFinite(length)||length<=0)fail(400,'VALIDATION_ERROR','Roll length must be greater than zero.');if(weight!==null&&(!Number.isFinite(weight)||weight<=0))fail(400,'VALIDATION_ERROR','Roll weight must be greater than zero.');
 return transaction(async(client)=>{await actor(client,userId);const log=await client.query(`SELECT pl.production_log_id,pl.good_meters,pl.worker_id,pl.shift_id,ma.machine_id,ma.job_id,j.order_item_id,h.supervisor_user_id FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id WHERE pl.production_log_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF pl`,[id(input.productionLogId,'Production log'),userId]);if(!log.rowCount)notFound('Production log');const row=log.rows[0];const used=await client.query(`SELECT COALESCE(sum(length_meters),0) used_m FROM production.rolls WHERE production_log_id=$1`,[row.production_log_id]);if(Number(used.rows[0].used_m)+length>Number(row.good_meters))fail(409,'ROLL_OUTPUT_EXCEEDED','Roll length exceeds unallocated net good metres after waste.');const result=await client.query(`INSERT INTO production.rolls(order_item_id,job_id,production_log_id,machine_id,shift_id,produced_by_worker_id,length_meters,weight_kg,label_qr_value,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING roll_id,roll_no,current_status,length_meters,weight_kg,label_qr_value,produced_at`,[row.order_item_id,row.job_id,row.production_log_id,row.machine_id,row.shift_id,row.worker_id,length,weight,String(input.label||'').trim()||null,String(input.notes||'').slice(0,500)||null]);return result.rows[0];});
}

async function qualityPending(userId,query={}) { return rolls(userId,{...query,state:'pending'}); }
async function rollDetail(userId,rollId) { const result=await pool.query(`SELECT r.*,e.job_no,e.order_no,e.company_name,e.fabric_name,e.colour_name,e.stage,m.machine_name,w.employee_code,u.full_name AS worker_name FROM production.rolls r JOIN reporting.production_job_efficiency e USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=r.job_id LEFT JOIN master.machines m USING(machine_id) LEFT JOIN hr.workers w ON w.worker_id=r.produced_by_worker_id LEFT JOIN auth.users u ON u.user_id=w.user_id WHERE r.roll_id=$1 AND h.supervisor_user_id=$2`,[id(rollId,'Roll'),userId]);if(!result.rowCount)notFound('Roll');const [inspections,defects]=await Promise.all([pool.query(`SELECT i.*,u.full_name AS inspector_name FROM quality.inspections i JOIN auth.users u ON u.user_id=i.inspected_by WHERE i.roll_id=$1 ORDER BY i.inspected_at DESC,i.inspection_id DESC`,[rollId]),pool.query(`SELECT d.defect_type_id,d.defect_name,d.default_severity FROM master.defect_types d WHERE d.is_active ORDER BY d.defect_name`)]);const details=await Promise.all(inspections.rows.map(async(i)=>({...i,defects:(await pool.query(`SELECT id.*,d.defect_name FROM quality.inspection_defects id JOIN master.defect_types d USING(defect_type_id) WHERE id.inspection_id=$1 ORDER BY d.defect_name`,[i.inspection_id])).rows})));return {...result.rows[0],inspections:details,defectTypes:defects.rows}; }
async function defectTypes() {return (await pool.query(`SELECT defect_type_id,defect_name,default_severity FROM master.defect_types WHERE is_active ORDER BY defect_name`)).rows;}
async function inspectRoll(userId,rollId,input) {
 const result=String(input.result||'');if(!['PASS','REWORK','REJECT'].includes(result))fail(400,'VALIDATION_ERROR','Choose PASS, REWORK, or REJECT.');
 const why=String(input.reason||'').trim(), instructions=String(input.reworkInstructions||'').trim(), notes=String(input.notes||'').trim();
 if(result!=='PASS'&&why.length<5)fail(400,'VALIDATION_ERROR',`${result==='REJECT'?'A rejection':'A rework'} reason is required.`);if(result==='REWORK'&&instructions.length<5)fail(400,'VALIDATION_ERROR','Actionable rework instructions are required.');
 if([why,instructions,notes].some((x)=>x.length>1000))fail(400,'VALIDATION_ERROR','Inspection notes must be at most 1000 characters.');
 if(!Array.isArray(input.defects)||input.defects.length>30)fail(400,'VALIDATION_ERROR','Defects must be a list of at most 30 records.');
 const seen=new Set();const defects=input.defects.map((d)=>{const defectTypeId=id(d.defectTypeId,'Defect type'),severity=String(d.severity||'').toUpperCase(),count=Number(d.count??1);if(!['MINOR','MAJOR','CRITICAL'].includes(severity)||!Number.isInteger(count)||count<1)fail(400,'VALIDATION_ERROR','Defect severity or count is invalid.');if(seen.has(`${defectTypeId}:${severity}`))fail(400,'VALIDATION_ERROR','Each defect type and severity can be added only once.');seen.add(`${defectTypeId}:${severity}`);return {defectTypeId,severity,count,notes:String(d.notes||'').slice(0,300)};});
 if(result==='PASS'&&defects.some((d)=>d.severity!=='MINOR'))fail(400,'MAJOR_DEFECT_CANNOT_PASS','A roll with major or critical defects cannot pass inspection.');
 return transaction(async(client)=>{await actor(client,userId);const roll=await client.query(`SELECT r.roll_id,r.job_id,r.order_item_id,r.length_meters,r.current_status,r.replacement_request_id,oi.fabric_type_id,h.supervisor_user_id FROM production.rolls r JOIN sales.order_items oi ON oi.order_item_id=r.order_item_id JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE r.roll_id=$1 AND h.supervisor_user_id=$2 FOR UPDATE OF r`,[id(rollId,'Roll'),userId]);if(!roll.rowCount)notFound('Roll');if(roll.rows[0].current_status==='DISPATCHED')fail(409,'ROLL_DISPATCHED','A dispatched roll cannot be inspected.');if(roll.rows[0].current_status==='REJECTED')fail(409,'ROLL_REJECTED','Rejected rolls are terminal and cannot be reinspected.');if(!['PENDING_QC','REWORK'].includes(roll.rows[0].current_status))fail(409,'ROLL_NOT_INSPECTABLE','Only pending QC or rework rolls can be inspected.');
  if(result==='PASS'&&roll.rows[0].current_status==='REWORK'){
    const progress=await client.query(`SELECT latest.inspection_id,COALESCE(sum(a.allocated_meters),0) AS allocated_meters
      FROM (SELECT inspection_id FROM quality.inspections WHERE roll_id=$1 ORDER BY inspected_at DESC,inspection_id DESC LIMIT 1) latest
      LEFT JOIN production.machine_assignment_rework_rolls ar ON ar.roll_id=$1 AND ar.source_inspection_id=latest.inspection_id
      LEFT JOIN production.rework_roll_log_allocations a ON a.roll_id=ar.roll_id
      LEFT JOIN production.production_logs pl ON pl.production_log_id=a.production_log_id AND pl.machine_assignment_id=ar.machine_assignment_id
      GROUP BY latest.inspection_id`,[rollId]);
    if(!progress.rowCount||Number(progress.rows[0].allocated_meters)<Number(roll.rows[0].length_meters))fail(409,'REWORK_INCOMPLETE','The full selected roll length must be logged as net good rework before it can pass inspection.');
  }
  for(const d of defects){const exists=await client.query(`SELECT 1 FROM master.defect_types WHERE defect_type_id=$1 AND is_active`,[d.defectTypeId]);if(!exists.rowCount)fail(400,'INVALID_DEFECT_TYPE','Choose an active defect type.');}
  const inspection=await client.query(`INSERT INTO quality.inspections(roll_id,result,inspected_by,reason,rework_instructions,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING inspection_id,inspection_no,result,inspected_at,reason,rework_instructions,notes`,[rollId,result,userId,why||null,instructions||null,notes||null]);
  for(const d of defects)await client.query(`INSERT INTO quality.inspection_defects(inspection_id,defect_type_id,severity,defect_count,notes) VALUES($1,$2,$3,$4,$5)`,[inspection.rows[0].inspection_id,d.defectTypeId,d.severity,d.count,d.notes||null]);
  if(result==='PASS'&&roll.rows[0].replacement_request_id){const request=await client.query(`SELECT q.replacement_request_id,r.length_meters AS target_meters,
      COALESCE((SELECT sum(rr.length_meters) FROM production.rolls rr WHERE rr.replacement_request_id=q.replacement_request_id AND rr.current_status='PASSED'),0) AS passed_meters
      FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id
      WHERE q.replacement_request_id=$1 FOR UPDATE OF q`,[roll.rows[0].replacement_request_id]);if(request.rowCount&&Number(request.rows[0].passed_meters)>=Number(request.rows[0].target_meters))await client.query(`UPDATE production.replacement_material_requests SET status='COMPLETED',completed_at=now() WHERE replacement_request_id=$1 AND status='PRODUCED'`,[request.rows[0].replacement_request_id]);}
  if(result!=='PASS'){const owner=await client.query(`SELECT created_by FROM production.store_handoffs WHERE production_job_id=$1`,[roll.rows[0].job_id]);if(owner.rowCount)await client.query(`INSERT INTO notification.user_notifications(recipient_user_id,category,title,message,entity_type,entity_id) VALUES($1,'QUALITY',$2,$3,'ROLL',$4)`,[owner.rows[0].created_by,result==='REJECT'?'Fabric roll rejected':'Fabric roll requires rework',`Roll inspection ${inspection.rows[0].inspection_no}: ${why}`,rollId]);}
  let replacementRequest=null;
  if(result==='REJECT'){
    const bom=await client.query(`SELECT fb.yarn_type_id,ROUND(GREATEST($1::numeric*fb.kg_per_meter*(1+fb.wastage_percent/100),0.001),3) AS required_kg
      FROM master.fabric_bom fb JOIN master.yarn_types yt USING(yarn_type_id)
      WHERE fb.fabric_type_id=$2 AND yt.is_active ORDER BY fb.yarn_type_id`,[roll.rows[0].length_meters,roll.rows[0].fabric_type_id]);
    if(!bom.rowCount)fail(409,'MISSING_BOM','The rejected roll cannot be sent for replacement because its product has no active bill of materials.');
    const request=await client.query(`INSERT INTO production.replacement_material_requests(job_id,rejected_roll_id,requested_by)
      VALUES($1,$2,$3) RETURNING replacement_request_id,request_no,status,requested_at`,[roll.rows[0].job_id,rollId,userId]);
    replacementRequest=request.rows[0];
    for(const material of bom.rows)await client.query(`INSERT INTO production.replacement_material_request_items(replacement_request_id,yarn_type_id,required_kg) VALUES($1,$2,$3)`,[replacementRequest.replacement_request_id,material.yarn_type_id,material.required_kg]);
    await client.query(`SELECT notification.notify_role('STORE_MANAGER','STOCK',$1,$2,'REPLACEMENT_REQUEST',$3)`,[`Replacement materials requested · ${replacementRequest.request_no}`,`Roll ${rollId} was rejected. Review and approve its replacement materials for the linked production job.`,replacementRequest.replacement_request_id]);
  }
  return {...inspection.rows[0],defects,replacementRequest};
 });
}
async function inspections(userId,query={}) {return (await pool.query(`SELECT i.inspection_id,i.inspection_no,i.result,i.inspected_at,i.reason,i.rework_instructions,r.roll_id,r.roll_no,r.length_meters,e.job_no,e.order_no,e.fabric_name,u.full_name AS inspector_name FROM quality.inspections i JOIN production.rolls r USING(roll_id) JOIN reporting.production_job_efficiency e USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=r.job_id JOIN auth.users u ON u.user_id=i.inspected_by WHERE h.supervisor_user_id=$1 ORDER BY i.inspected_at DESC LIMIT $2 OFFSET $3`,[userId,Math.min(Math.max(Number(query.limit)||50,1),100),Math.max(Number(query.offset)||0,0)])).rows;}
async function inspectionDetail(userId,inspectionId) {const found=await pool.query(`SELECT i.*,r.roll_id,r.roll_no,r.length_meters,e.job_no,e.order_no,e.fabric_name,e.colour_name,u.full_name AS inspector_name FROM quality.inspections i JOIN production.rolls r USING(roll_id) JOIN reporting.production_job_efficiency e USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=r.job_id JOIN auth.users u ON u.user_id=i.inspected_by WHERE i.inspection_id=$1 AND h.supervisor_user_id=$2`,[id(inspectionId,'Inspection'),userId]);if(!found.rowCount)notFound('Inspection');const defects=await pool.query(`SELECT d.*,t.defect_name FROM quality.inspection_defects d JOIN master.defect_types t USING(defect_type_id) WHERE d.inspection_id=$1 ORDER BY t.defect_name`,[inspectionId]);return {...found.rows[0],defects:defects.rows};}

async function report(userId,kind,query={}) {
 const from=String(query.from||new Date().toISOString().slice(0,10)),to=String(query.to||from);const valid=/^\d{4}-\d{2}-\d{2}$/;
 if(!valid.test(from)||!valid.test(to)||from>to)fail(400,'VALIDATION_ERROR','Use a valid date range with from on or before to.');
 if(kind==='production')return (await pool.query(`WITH period_logs AS (
    SELECT ma.job_id,sum(pl.good_meters) produced_meters,sum(pl.waste_meters) waste_meters,sum(pl.downtime_minutes) downtime_minutes
    FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id)
    WHERE pl.logged_at::date BETWEEN $2::date AND $3::date GROUP BY ma.job_id
  ), period_qc AS (
    SELECT r.job_id,sum(r.length_meters) FILTER(WHERE r.current_status IN('PASSED','DISPATCHED')) qc_passed_meters,
      sum(r.length_meters) FILTER(WHERE r.current_status='REWORK') rework_meters,
      sum(r.length_meters) FILTER(WHERE r.current_status='REJECTED') rejected_meters
    FROM production.rolls r WHERE r.produced_at::date BETWEEN $2::date AND $3::date GROUP BY r.job_id
  ) SELECT e.job_id,e.job_no,e.order_no,e.company_name,e.fabric_name,e.colour_name,e.stage,e.job_status,e.planned_meters,
      COALESCE(l.produced_meters,0) produced_meters,COALESCE(l.waste_meters,0) waste_meters,COALESCE(l.downtime_minutes,0) downtime_minutes,
      round(COALESCE(l.produced_meters,0)/NULLIF(e.planned_meters,0)*100,2) plan_attainment_percent,
      COALESCE(q.qc_passed_meters,0) qc_passed_meters,COALESCE(q.rework_meters,0) rework_meters,COALESCE(q.rejected_meters,0) rejected_meters,
      round(COALESCE(q.qc_passed_meters,0)/NULLIF(l.produced_meters,0)*100,2) qc_yield_percent
    FROM reporting.production_job_efficiency e LEFT JOIN period_logs l USING(job_id) LEFT JOIN period_qc q USING(job_id)
    WHERE EXISTS(SELECT 1 FROM production.store_handoffs h WHERE h.production_job_id=e.job_id AND h.supervisor_user_id=$1)
      AND (l.job_id IS NOT NULL OR q.job_id IS NOT NULL) ORDER BY e.job_no`,[userId,from,to])).rows;
 if(kind==='quality')return (await pool.query(`SELECT r.current_status,count(*)::int AS rolls,COALESCE(sum(r.length_meters),0) meters FROM production.rolls r JOIN production.store_handoffs h ON h.production_job_id=r.job_id WHERE h.supervisor_user_id=$1 AND r.produced_at::date BETWEEN $2::date AND $3::date GROUP BY r.current_status ORDER BY r.current_status`,[userId,from,to])).rows;
 if(kind==='machines')return (await pool.query(`SELECT m.machine_code,m.machine_name,m.stage,COALESCE(sum(pl.good_meters),0) produced_meters,COALESCE(sum(pl.waste_meters),0) waste_meters,COALESCE(sum(pl.downtime_minutes),0) downtime_minutes FROM master.machines m JOIN production.machine_assignments ma USING(machine_id) JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id AND h.supervisor_user_id=$1 LEFT JOIN production.production_logs pl ON pl.machine_assignment_id=ma.machine_assignment_id AND pl.logged_at::date BETWEEN $2::date AND $3::date GROUP BY m.machine_id ORDER BY m.machine_code`,[userId,from,to])).rows;
 return (await pool.query(`SELECT w.employee_code,u.full_name,COALESCE(sum(pl.good_meters),0) produced_meters,COALESCE(sum(pl.waste_meters),0) waste_meters,COALESCE(sum(pl.downtime_minutes),0) downtime_minutes FROM hr.workers w JOIN auth.users u USING(user_id) JOIN production.job_worker_assignments jwa USING(worker_id) JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN production.store_handoffs h ON h.production_job_id=j.job_id AND h.supervisor_user_id=$1 LEFT JOIN production.production_logs pl ON pl.machine_assignment_id=ma.machine_assignment_id AND pl.worker_id=w.worker_id AND pl.logged_at::date BETWEEN $2::date AND $3::date GROUP BY w.worker_id,u.full_name ORDER BY produced_meters DESC,w.employee_code`,[userId,from,to])).rows;
}

module.exports={dashboard,handoffs,handoff,transitionHandoff,createJob,jobs,job,assignMachine,workers,createWorker,updateWorkerShift,shifts,assignWorker,unassignWorker,machines,createMachine,machine,machineHistory,statusEvent,breakdowns,logs,rolls,createRoll,qualityPending,rollDetail,defectTypes,inspectRoll,inspections,inspectionDetail,report};

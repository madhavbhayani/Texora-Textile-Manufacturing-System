'use strict';

const { pool } = require('../../../database/config/db');
const AppError = require('../../../shared/errors/AppError');

function positiveId(value, label) {
  if (!/^\d+$/.test(String(value || '')) || Number(value) < 1) throw new AppError(400, 'VALIDATION_ERROR', `${label} must be a positive ID.`);
  return Number(value);
}
function paging(query = {}) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  return { limit, offset };
}
function dateFilter(value, label) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)
    throw new AppError(400, 'VALIDATION_ERROR', `${label} must use YYYY-MM-DD format.`);
  return value;
}
async function workerFor(userId, executor = pool, lock = false) {
  const result = await executor.query(`SELECT w.worker_id,w.employee_code,w.user_id,w.designation,w.skill_stage,w.default_shift_id,
    w.joined_on,w.is_active,
    u.full_name,u.email,u.phone,u.is_active AS account_active
    FROM hr.workers w JOIN auth.users u USING(user_id) WHERE w.user_id=$1 ${lock ? 'FOR UPDATE OF w' : ''}`, [userId]);
  if (!result.rowCount) throw new AppError(404, 'WORKER_PROFILE_NOT_FOUND', 'Your worker profile is not configured. Contact your Supervisor.');
  if (!result.rows[0].is_active || !result.rows[0].account_active) throw new AppError(403, 'WORKER_INACTIVE', 'Your worker account is inactive.');
  return result.rows[0];
}
async function transaction(work) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function setActor(client, userId) { await client.query("SELECT set_config('app.current_user_id',$1,TRUE)", [String(userId)]); }
function businessConflict(error) {
  if (error instanceof AppError) throw error;
  if (error.code === '23505') {
    const messages = {
      ux_worker_one_active_job: 'You already have another active production assignment. Ask your Supervisor to move you before starting this job.',
      ux_machine_one_active_assignment: 'This machine already has an active assignment. Refresh Machine Operations and contact your Supervisor if the assignment looks incorrect.',
      ux_job_one_active_machine: 'This job already has an active machine assignment. Refresh Machine Operations and contact your Supervisor if it looks incorrect.',
      attendance_worker_id_work_date_shift_id_key: 'Attendance is already recorded for this shift today. Refresh your attendance page.',
      rolls_label_qr_value_key: 'That roll label is already in use. Enter a different label and try again.',
    };
    throw new AppError(409, 'CONFLICT', messages[error.constraint] || 'This record already exists. Refresh the page and review the current assignment before trying again.');
  }
  if (error.code === '42501') throw new AppError(403, 'FORBIDDEN', 'You are not permitted to perform this operation.');
  if (error.code === 'P0001') throw new AppError(422, 'BUSINESS_RULE_VIOLATION', error.message.replace(/^ERROR:\s*/i, '').split('\n')[0]);
  if (error.code === '23514' || error.code === '23503' || error.code === '22003' || error.code === '22007') throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'The submitted values conflict with current production or attendance rules.');
  throw error;
}

async function profile(userId) {
  const worker = await workerFor(userId);
  const shift = worker.default_shift_id ? (await pool.query('SELECT shift_id,shift_name,start_time,end_time FROM master.shifts WHERE shift_id=$1 AND is_active', [worker.default_shift_id])).rows[0] : null;
  return { worker_id: worker.worker_id, employee_code: worker.employee_code, user_id: worker.user_id,
    designation: worker.designation, skill_stage: worker.skill_stage, joined_on: worker.joined_on,
    is_active: worker.is_active, full_name: worker.full_name, email: worker.email, phone: worker.phone,
    account_active: worker.account_active, default_shift: shift || null };
}
async function dashboard(userId) {
  const w = await workerFor(userId);
  const [attendance, current, recent, alerts] = await Promise.all([
    pool.query(`SELECT a.*,s.shift_name FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id
      WHERE a.worker_id=$1 AND a.work_date=CURRENT_DATE ORDER BY a.check_in DESC NULLS LAST LIMIT 1`, [w.worker_id]),
    pool.query(`SELECT ma.machine_assignment_id,ma.status AS assignment_status,ma.assigned_at,ma.started_at,j.job_id,j.job_no,j.stage,j.status AS job_status,j.planned_meters,
      m.machine_code,m.machine_name,m.status AS machine_status,sh.shift_name,
      COALESCE(sum(pl.good_meters),0) AS produced_meters,COALESCE(sum(pl.produced_meters),0) AS gross_meters,COALESCE(sum(pl.waste_meters),0) AS waste_meters,COALESCE(sum(pl.downtime_minutes),0) AS downtime_minutes
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=ma.shift_id
      LEFT JOIN production.production_logs pl ON pl.machine_assignment_id=ma.machine_assignment_id
      WHERE jwa.worker_id=$1 AND jwa.unassigned_at IS NULL AND (jwa.ended_at IS NULL OR ma.status='PAUSED') AND ma.status IN ('ASSIGNED','RUNNING','PAUSED')
      GROUP BY ma.machine_assignment_id,j.job_id,m.machine_id,sh.shift_id ORDER BY ma.assigned_at DESC LIMIT 1`, [w.worker_id]),
    pool.query(`SELECT pl.production_log_id,pl.logged_at,pl.produced_meters,pl.good_meters,pl.waste_meters,pl.downtime_minutes,pl.remarks,j.job_no,m.machine_code
      FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id)
      WHERE pl.worker_id=$1 ORDER BY pl.logged_at DESC LIMIT 5`, [w.worker_id]),
    pool.query(`SELECT count(*) FILTER (WHERE ma.status='PAUSED') AS paused_count
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      WHERE jwa.worker_id=$1 AND jwa.unassigned_at IS NULL AND ma.status='PAUSED'`, [w.worker_id]),
  ]);
  const activeAttendance = attendance.rows[0] || null;
  const currentJob = current.rows[0] || null;
  const notices = [];
  if (!activeAttendance) notices.push({ code: 'ATTENDANCE_MISSING', message: 'Check in for your current shift.' });
  else if (activeAttendance.check_in && !activeAttendance.check_out) notices.push({ code: 'CHECKOUT_OPEN', message: 'Remember to check out when your shift ends.' });
  if (!currentJob) notices.push({ code: 'NO_ASSIGNMENT', message: 'No active production assignment is linked to your profile.' });
  if (currentJob?.machine_status === 'BREAKDOWN' || currentJob?.machine_status === 'MAINTENANCE') notices.push({ code: 'MACHINE_UNAVAILABLE', message: `Your machine is ${currentJob.machine_status.toLowerCase()}. Contact your Supervisor.` });
  if (Number(alerts.rows[0]?.paused_count) > 0) notices.push({ code: 'JOB_PAUSED', message: 'An assigned production job is paused.' });
  return { worker: { employee_code: w.employee_code, full_name: w.full_name }, attendance: activeAttendance,
    current_job: currentJob, recent_logs: recent.rows, alerts: notices };
}

async function attendance(userId, query = {}) {
  const w = await workerFor(userId), { limit, offset } = paging(query);
  const values = [w.worker_id], filters = ['a.worker_id=$1'];
  const from=dateFilter(query.from,'Start date'),to=dateFilter(query.to,'End date');
  if (from) { values.push(from); filters.push(`a.work_date >= $${values.length}::date`); }
  if (to) { values.push(to); filters.push(`a.work_date <= $${values.length}::date`); }
  if (from&&to&&from>to) throw new AppError(400,'VALIDATION_ERROR','Start date must not be after end date.');
  values.push(limit, offset);
  const [result, openAttendance] = await Promise.all([pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.remarks,s.shift_name
    FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id WHERE ${filters.join(' AND ')}
    ORDER BY a.work_date DESC,a.check_in DESC NULLS LAST LIMIT $${values.length - 1} OFFSET $${values.length}`, values), pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.remarks,s.shift_name
    FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id WHERE a.worker_id=$1 AND a.check_in IS NOT NULL AND a.check_out IS NULL
    ORDER BY a.check_in DESC LIMIT 1`, [w.worker_id])]);
  return { records: result.rows, openAttendance: openAttendance.rows[0] || null, limit, offset };
}
async function attendanceDetail(userId, attendanceId) {
  const w = await workerFor(userId);
  const result = await pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.remarks,s.shift_name
    FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id WHERE a.attendance_id=$1 AND a.worker_id=$2`, [positiveId(attendanceId, 'Attendance ID'), w.worker_id]);
  if (!result.rowCount) throw new AppError(404, 'NOT_FOUND', 'Attendance record was not found.');
  return result.rows[0];
}
async function checkIn(userId) {
  try { return await transaction(async client => {
    await setActor(client, userId); const w = await workerFor(userId, client, true);
    if (!w.default_shift_id) throw new AppError(422, 'SHIFT_REQUIRED', 'Ask your Supervisor to assign a default shift before checking in.');
    const shift = await client.query('SELECT shift_id FROM master.shifts WHERE shift_id=$1 AND is_active FOR SHARE', [w.default_shift_id]);
    if (!shift.rowCount) throw new AppError(422, 'SHIFT_INACTIVE', 'Your configured shift is inactive. Contact your Supervisor.');
    const existing = await client.query('SELECT attendance_id,check_in,check_out FROM hr.attendance WHERE worker_id=$1 AND shift_id=$2 AND work_date=CURRENT_DATE FOR UPDATE', [w.worker_id, w.default_shift_id]);
    if (existing.rowCount) throw new AppError(409, 'ALREADY_CHECKED_IN', existing.rows[0].check_out ? 'Attendance is already complete for this shift today.' : 'You are already checked in for this shift today.');
    const priorOpen = await client.query('SELECT attendance_id FROM hr.attendance WHERE worker_id=$1 AND check_in IS NOT NULL AND check_out IS NULL LIMIT 1 FOR UPDATE', [w.worker_id]);
    if (priorOpen.rowCount) throw new AppError(409, 'OPEN_ATTENDANCE_EXISTS', 'Check out of your previous open attendance before checking in again.');
    return (await client.query(`INSERT INTO hr.attendance(worker_id,work_date,shift_id,status,check_in,marked_by)
      VALUES($1,CURRENT_DATE,$2,'PRESENT',now(),$3) RETURNING *`, [w.worker_id, w.default_shift_id, userId])).rows[0];
  }); } catch (e) { businessConflict(e); }
}
async function checkOut(userId) {
  try { return await transaction(async client => {
    await setActor(client, userId); const w = await workerFor(userId, client, true);
    const open = await client.query(`SELECT attendance_id FROM hr.attendance WHERE worker_id=$1 AND check_in IS NOT NULL AND check_out IS NULL
      ORDER BY check_in DESC LIMIT 1 FOR UPDATE`, [w.worker_id]);
    if (!open.rowCount) throw new AppError(409, 'NO_OPEN_ATTENDANCE', 'There is no open check-in for your account today.');
    const result = await client.query(`UPDATE hr.attendance SET check_out=now(),marked_by=$2 WHERE attendance_id=$1 RETURNING *`, [open.rows[0].attendance_id, userId]);
    return result.rows[0];
  }); } catch (e) { businessConflict(e); }
}

const jobSelect = `SELECT j.job_id,j.job_no,j.order_item_id,o.order_no,ft.fabric_name,c.colour_name,j.stage,j.planned_meters,j.status AS job_status,
  ma.machine_assignment_id,ma.status AS assignment_status,ma.assigned_at,ma.started_at,ma.ended_at,ma.notes AS assignment_notes,ma.replacement_request_id,
  m.machine_id,m.machine_code,m.machine_name,m.status AS machine_status,sh.shift_id,sh.shift_name,sh.start_time,sh.end_time,
  COALESCE(sum(pl.good_meters),0) AS produced_meters,COALESCE(sum(pl.produced_meters),0) AS gross_meters,COALESCE(sum(pl.waste_meters),0) AS waste_meters,
  COALESCE(sum(pl.downtime_minutes),0) AS downtime_minutes,
  GREATEST(j.planned_meters-COALESCE(sum(pl.good_meters),0),0) AS remaining_meters,
  (SELECT count(*)::integer FROM production.machine_assignment_rework_rolls ar WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_roll_count,
  (SELECT COALESCE(sum(rr.length_meters),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls rr USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_meters,
  (SELECT COALESCE(sum(GREATEST(rr.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=rr.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls rr USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_remaining_meters,
  (SELECT COALESCE(sum(GREATEST(rr.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=rr.roll_id AND ar2.source_inspection_id=ar.source_inspection_id AND pl2.machine_assignment_id<>ma.machine_assignment_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls rr USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_assignment_target_meters,
  (SELECT count(*)::integer FROM production.machine_assignment_rework_rolls ar WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS assigned_rework_roll_count,
  (SELECT q.status FROM production.replacement_material_requests q WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_status,
  (SELECT q.request_no FROM production.replacement_material_requests q WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_request_no,
  (SELECT r.roll_no FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_roll_no,
  (SELECT r.length_meters FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_target_meters,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',rr.roll_id,'roll_no',rr.roll_no,'length_meters',rr.length_meters,'allocated_meters',COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE a.roll_id=rr.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0),'reason',qi.reason,'instructions',qi.rework_instructions) ORDER BY rr.produced_at,rr.roll_id)
    FROM production.machine_assignment_rework_rolls ar JOIN production.rolls rr USING(roll_id)
    LEFT JOIN quality.inspections qi ON qi.inspection_id=ar.source_inspection_id
    WHERE ar.machine_assignment_id=ma.machine_assignment_id),'[]'::jsonb) AS rework_details
  FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
  JOIN production.jobs j USING(job_id) JOIN sales.order_items oi ON oi.order_item_id=j.order_item_id JOIN sales.orders o USING(order_id)
  JOIN master.fabric_types ft USING(fabric_type_id) LEFT JOIN master.colours c USING(colour_id)
  JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=ma.shift_id
  LEFT JOIN production.production_logs pl ON pl.machine_assignment_id=ma.machine_assignment_id`;
async function jobs(userId, query = {}) {
  const w = await workerFor(userId), { limit, offset } = paging(query);
  const result = await pool.query(`${jobSelect} WHERE jwa.worker_id=$1 GROUP BY j.job_id,ma.machine_assignment_id,m.machine_id,sh.shift_id,oi.order_item_id,o.order_id,ft.fabric_type_id,c.colour_id
    ORDER BY ma.assigned_at DESC LIMIT $2 OFFSET $3`, [w.worker_id, limit, offset]); return { jobs: result.rows, limit, offset };
}
async function jobDetail(userId, jobId) {
  const w = await workerFor(userId), id = positiveId(jobId, 'Job ID');
  const result = await pool.query(`${jobSelect} WHERE jwa.worker_id=$1 AND j.job_id=$2 GROUP BY j.job_id,ma.machine_assignment_id,m.machine_id,sh.shift_id,oi.order_item_id,o.order_id,ft.fabric_type_id,c.colour_id ORDER BY ma.assigned_at DESC LIMIT 1`, [w.worker_id, id]);
  if (!result.rowCount) throw new AppError(404, 'NOT_FOUND', 'Assigned job was not found.');
  const logs = await pool.query(`SELECT production_log_id,logged_at,produced_meters,good_meters,waste_meters,downtime_minutes,remarks FROM production.production_logs
    WHERE machine_assignment_id=$1 AND worker_id=$2 ORDER BY logged_at,production_log_id`, [result.rows[0].machine_assignment_id,w.worker_id]);
  return { ...result.rows[0], logs: logs.rows };
}
async function jobProgress(userId, jobId) {
  const job = await jobDetail(userId, jobId);
  return { job_id: job.job_id, planned_meters: job.planned_meters, produced_meters: job.produced_meters, waste_meters: job.waste_meters,
    remaining_meters: job.remaining_meters, downtime_minutes: job.downtime_minutes };
}

async function assignmentAction(userId, assignmentId, action) {
  try { return await transaction(async client => {
    await setActor(client, userId); const w = await workerFor(userId, client, true), id = positiveId(assignmentId, 'Assignment ID');
    const row = await client.query(`SELECT ma.machine_assignment_id,ma.job_id,ma.machine_id,ma.status AS assignment_status,j.status AS job_status,m.status AS machine_status,jwa.ended_at
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id)
      WHERE jwa.machine_assignment_id=$1 AND jwa.worker_id=$2 AND jwa.unassigned_at IS NULL FOR UPDATE OF ma,m,j`, [id, w.worker_id]);
    if (!row.rowCount) throw new AppError(404, 'NOT_FOUND', 'Machine assignment was not found for your account.');
    const a = row.rows[0];
    if (action === 'start') {
      if (a.ended_at && a.assignment_status !== 'PAUSED') throw new AppError(409, 'WORKER_ASSIGNMENT_CLOSED', 'Your worker assignment has ended. Contact your Supervisor if you need to be assigned again.');
      if (['BREAKDOWN', 'MAINTENANCE'].includes(a.machine_status)) throw new AppError(409, 'MACHINE_UNAVAILABLE', `Machine is ${a.machine_status.toLowerCase()}.`);
      const attendanceRow = await client.query(`SELECT 1 FROM hr.attendance WHERE worker_id=$1 AND work_date=CURRENT_DATE AND check_in IS NOT NULL AND check_out IS NULL`, [w.worker_id]);
      if (!attendanceRow.rowCount) throw new AppError(422, 'ATTENDANCE_REQUIRED', 'Check in for your shift before operating a machine.');
      const otherAssignment = await client.query(`SELECT ma.machine_assignment_id,ma.job_id,ma.status
        FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
        WHERE jwa.worker_id=$1 AND jwa.machine_assignment_id<>$2 AND jwa.ended_at IS NULL
          AND jwa.unassigned_at IS NULL AND ma.status IN ('ASSIGNED','RUNNING','PAUSED')
        LIMIT 1 FOR UPDATE OF jwa,ma`, [w.worker_id, id]);
      if (otherAssignment.rowCount) throw new AppError(409, 'WORKER_ALREADY_ASSIGNED', 'You already have another active production assignment. Ask your Supervisor to move you before starting this job.');
      await client.query('SELECT production.set_assignment_running($1,$2)', [id, userId]);
    } else if (action === 'stop') {
      if (a.assignment_status !== 'RUNNING') throw new AppError(409, 'ASSIGNMENT_NOT_RUNNING', 'Only a running assignment can be paused.');
      await client.query('SELECT production.stop_assignment($1,$2,FALSE)', [id, userId]);
    } else if (action === 'complete') {
      if (['COMPLETED','CANCELLED'].includes(a.job_status)) throw new AppError(409, 'JOB_CLOSED', 'This job is already closed.');
      const output = await client.query(`SELECT COALESCE(sum(pl.good_meters),0) AS produced,
        COALESCE((SELECT sum(r.length_meters) FROM production.rolls r JOIN production.production_logs pl2 ON pl2.production_log_id=r.production_log_id WHERE pl2.machine_assignment_id=$1),0) AS roll_meters
        FROM production.production_logs pl WHERE pl.machine_assignment_id=$1`, [id]);
      const plan = await client.query(`SELECT j.planned_meters,ma.notes,ma.replacement_request_id,
        (SELECT COALESCE(sum(GREATEST(r.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=r.roll_id AND ar2.source_inspection_id=ar.source_inspection_id AND pl2.machine_assignment_id<>ma.machine_assignment_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_meters,
    (SELECT COALESCE(sum(GREATEST(r.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=r.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_remaining_meters,
    (SELECT COALESCE(sum(GREATEST(r.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=r.roll_id AND ar2.source_inspection_id=ar.source_inspection_id AND pl2.machine_assignment_id<>ma.machine_assignment_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_assignment_target_meters,
        (SELECT r.length_meters FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_target_meters,
        (SELECT COALESCE(sum(r.length_meters),0) FROM production.rolls r WHERE r.replacement_request_id=ma.replacement_request_id) AS replacement_roll_meters
        FROM production.jobs j JOIN production.machine_assignments ma ON ma.job_id=j.job_id WHERE ma.machine_assignment_id=$1`, [id]);
      const isRework=String(plan.rows[0].notes||'').startsWith('REWORK:');
      const isReplacement=Boolean(plan.rows[0].replacement_request_id);
      const target=isReplacement?Number(plan.rows[0].replacement_target_meters):isRework?Number(plan.rows[0].rework_meters):Number(plan.rows[0].planned_meters);
      if (Number(output.rows[0].produced) < target) throw new AppError(422,'PRODUCTION_INCOMPLETE',`The assignment cannot be completed until recorded good output meets its ${isReplacement?'replacement':isRework?'selected rework':'planned'} metres target.`);
      if(!isRework&&!isReplacement&&Number(output.rows[0].roll_meters)<Number(output.rows[0].produced))throw new AppError(422,'PRODUCTION_ROLLS_INCOMPLETE','Register rolls for all recorded good output before finishing this production assignment.');
      if(isReplacement&&Number(plan.rows[0].replacement_roll_meters)<target)throw new AppError(422,'REPLACEMENT_ROLL_REQUIRED','Register replacement rolls for the rejected roll before completing this assignment.');
      await client.query('SELECT production.stop_assignment($1,$2,TRUE)', [id, userId]);
      if(isReplacement){await client.query(`UPDATE production.replacement_material_requests SET status='PRODUCED',produced_at=now() WHERE replacement_request_id=$1 AND status='ISSUED'`,[plan.rows[0].replacement_request_id]);await client.query(`UPDATE production.replacement_material_requests q SET status='COMPLETED',completed_at=now() WHERE q.replacement_request_id=$1 AND q.status='PRODUCED' AND (SELECT COALESCE(sum(r.length_meters),0) FROM production.rolls r WHERE r.replacement_request_id=q.replacement_request_id AND r.current_status='PASSED') >= (SELECT rejected.length_meters FROM production.rolls rejected WHERE rejected.roll_id=q.rejected_roll_id)`,[plan.rows[0].replacement_request_id]);}
    }
    return (await client.query(`SELECT ma.machine_assignment_id,ma.status AS assignment_status,j.job_id,j.job_no,j.status AS job_status,m.machine_status
      FROM production.machine_assignments ma JOIN production.jobs j USING(job_id) JOIN LATERAL (SELECT status AS machine_status FROM master.machines WHERE machine_id=ma.machine_id) m ON TRUE WHERE ma.machine_assignment_id=$1`, [id])).rows[0];
  }); } catch (e) { businessConflict(e); }
}
async function machineList(userId) {
  const w=await workerFor(userId); return (await pool.query(`SELECT m.machine_id,m.machine_code,m.machine_name,m.stage,m.status,
    j.job_id,j.job_no,j.status AS job_status,ma.machine_assignment_id,ma.status AS assignment_status,ma.notes AS assignment_notes,ma.replacement_request_id,sh.shift_name,
    COALESCE((SELECT sum(good_meters) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id),0) AS produced_meters,
    COALESCE((SELECT sum(produced_meters) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id),0) AS gross_meters,j.planned_meters,
    (SELECT COALESCE(sum(r.length_meters),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_meters,
    (SELECT COALESCE(sum(GREATEST(r.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=r.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_remaining_meters,
    (SELECT COALESCE(sum(GREATEST(r.length_meters-COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE ar2.roll_id=r.roll_id AND ar2.source_inspection_id=ar.source_inspection_id AND pl2.machine_assignment_id<>ma.machine_assignment_id),0),0)),0) FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=ma.machine_assignment_id) AS rework_assignment_target_meters,
    (SELECT q.status FROM production.replacement_material_requests q WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_status,
    (SELECT q.request_no FROM production.replacement_material_requests q WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_request_no,
    (SELECT r.roll_no FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_roll_no,
    (SELECT r.length_meters FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE q.replacement_request_id=ma.replacement_request_id) AS replacement_target_meters,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',rr.roll_id,'roll_no',rr.roll_no,'length_meters',rr.length_meters,'allocated_meters',COALESCE((SELECT sum(a.allocated_meters) FROM production.rework_roll_log_allocations a JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a.roll_id WHERE a.roll_id=rr.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0),'reason',qi.reason,'instructions',qi.rework_instructions) ORDER BY rr.produced_at,rr.roll_id)
      FROM production.machine_assignment_rework_rolls ar JOIN production.rolls rr USING(roll_id)
      LEFT JOIN quality.inspections qi ON qi.inspection_id=ar.source_inspection_id
      WHERE ar.machine_assignment_id=ma.machine_assignment_id),'[]'::jsonb) AS rework_details
    FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
    JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=ma.shift_id
    WHERE jwa.worker_id=$1 AND jwa.unassigned_at IS NULL
      AND (jwa.ended_at IS NULL OR ma.status='PAUSED')
      AND ma.status IN ('ASSIGNED','RUNNING','PAUSED') ORDER BY ma.assigned_at DESC`,[w.worker_id])).rows;
}
async function reportBreakdown(userId, machineId, input = {}) {
  const reason=typeof input.reason==='string'?input.reason.trim():'';
  if (!reason || reason.length>300) throw new AppError(400,'VALIDATION_ERROR','Enter a breakdown reason of up to 300 characters.');
  const extra=typeof input.notes==='string'?input.notes.trim():'';
  if(extra.length>500) throw new AppError(400,'VALIDATION_ERROR','Notes must be 500 characters or fewer.');
  try { return await transaction(async client=>{
    await setActor(client,userId);const w=await workerFor(userId,client,true),id=positiveId(machineId,'Machine ID');
    const machine=await client.query(`SELECT m.machine_id,m.status FROM master.machines m WHERE m.machine_id=$1
      AND EXISTS(SELECT 1 FROM production.machine_assignments ma JOIN production.job_worker_assignments jwa USING(machine_assignment_id)
        WHERE ma.machine_id=m.machine_id AND ma.status IN ('ASSIGNED','RUNNING','PAUSED')
          AND jwa.worker_id=$2 AND jwa.unassigned_at IS NULL) FOR UPDATE OF m`,[id,w.worker_id]);
    if(!machine.rowCount) throw new AppError(404,'NOT_FOUND','Machine was not found on one of your assigned jobs.');
    if(machine.rows[0].status==='BREAKDOWN') throw new AppError(409,'ALREADY_BROKEN','This machine is already reported as broken.');
    if(machine.rows[0].status==='MAINTENANCE') throw new AppError(409,'MACHINE_IN_MAINTENANCE','This machine is under maintenance.');
    const event=await client.query(`INSERT INTO production.machine_status_events(machine_id,new_status,reason,reported_by)
      VALUES($1,'BREAKDOWN',$2,$3) RETURNING machine_status_event_id,machine_id,old_status,new_status,reason,started_at,reported_by`,[id,`${reason}${extra?` — ${extra}`:''}`,userId]);
    return event.rows[0];
  });}catch(e){businessConflict(e);}
}
async function createProductionLog(userId, input = {}) {
  const assignmentId=positiveId(input.assignmentId,'Assignment ID');
  const requestKey=typeof input.requestKey==='string'?input.requestKey:'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) throw new AppError(400,'VALIDATION_ERROR','A valid request identifier is required.');
  const produced=Number(input.producedMeters),waste=Number(input.wasteMeters||0),downtime=Number(input.downtimeMinutes||0),remarks=typeof input.remarks==='string'?input.remarks.trim():'';
  if(!Number.isFinite(produced)||produced<0||produced>10000000||!Number.isFinite(waste)||waste<0||waste>10000000||!Number.isInteger(downtime)||downtime<0||downtime>1440||produced+waste<=0&&downtime<=0||remarks.length>1000) throw new AppError(400,'VALIDATION_ERROR','Enter valid output, waste, downtime and notes.');
  if(waste>produced) throw new AppError(422,'WASTE_EXCEEDS_OUTPUT','Waste metres cannot exceed total output metres.');
  const good=Number((produced-waste).toFixed(2));
  const rolls=Array.isArray(input.rolls)?input.rolls:[];
  if(rolls.length>100) throw new AppError(400,'VALIDATION_ERROR','A log can include up to 100 rolls.');
  for(const roll of rolls) if(!Number.isFinite(Number(roll.lengthMeters))||Number(roll.lengthMeters)<=0||roll.lengthMeters>10000000||roll.weightKg!=null&&(!Number.isFinite(Number(roll.weightKg))||Number(roll.weightKg)<=0)) throw new AppError(400,'VALIDATION_ERROR','Each roll requires a positive length and optional positive weight.');
  const rollTotal=rolls.reduce((sum,r)=>sum+Number(r.lengthMeters),0);
  if(rollTotal>good) throw new AppError(422,'ROLL_OUTPUT_EXCEEDED','Roll lengths cannot exceed net good output after waste.');
  const reworkAllocations=Array.isArray(input.reworkAllocations)?input.reworkAllocations:[];
  if(reworkAllocations.length>100) throw new AppError(400,'VALIDATION_ERROR','A rework log can allocate up to 100 rolls.');
  for(const allocation of reworkAllocations) if(!Number.isInteger(Number(allocation.rollId))||Number(allocation.rollId)<=0||!Number.isFinite(Number(allocation.meters))||Number(allocation.meters)<=0) throw new AppError(400,'VALIDATION_ERROR','Each rework allocation requires a selected roll and positive metres.');
  const allocationTotal=reworkAllocations.reduce((sum,a)=>sum+Number(a.meters),0);
  if(reworkAllocations.length&&rolls.length) throw new AppError(422,'REWORK_ROLL_DUPLICATE','Rework output is added to its selected existing rolls; do not create new rolls.');
  try{return await transaction(async client=>{
    await setActor(client,userId);const w=await workerFor(userId,client,true),id=assignmentId;
    const existing=await client.query(`SELECT * FROM production.production_logs WHERE worker_id=$1 AND client_request_id=$2`,[w.worker_id,requestKey]);
    if(existing.rowCount){const existingRolls=await client.query(`SELECT roll_id,roll_no,length_meters,weight_kg,current_status FROM production.rolls WHERE production_log_id=$1 ORDER BY roll_id`,[existing.rows[0].production_log_id]);return {log:existing.rows[0],rolls:existingRolls.rows,duplicate:true};}
    const assignment=await client.query(`SELECT ma.machine_assignment_id,ma.job_id,ma.machine_id,ma.shift_id,ma.status,ma.notes,ma.replacement_request_id,m.status AS machine_status,j.order_item_id
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN master.machines m USING(machine_id) JOIN production.jobs j USING(job_id)
      WHERE jwa.machine_assignment_id=$1 AND jwa.worker_id=$2 AND jwa.ended_at IS NULL AND ma.status='RUNNING' FOR UPDATE OF ma,jwa,m`,[id,w.worker_id]);
    if(!assignment.rowCount) throw new AppError(409,'ASSIGNMENT_NOT_RUNNING','You must be actively assigned to a running machine to record production.');
    if(['BREAKDOWN','MAINTENANCE'].includes(assignment.rows[0].machine_status)) throw new AppError(409,'MACHINE_UNAVAILABLE','Production cannot be recorded while the machine is unavailable.');
    const a=assignment.rows[0];
    const isRework=String(a.notes||'').startsWith('REWORK:')&&!a.replacement_request_id;
    if(!isRework&&good>0&&(!rolls.length||Math.abs(rollTotal-good)>0.005))throw new AppError(422,'ROLL_BREAKDOWN_REQUIRED','Register rolls whose lengths add up to all net good output before saving this production log.');
    if(isRework&&rolls.length) throw new AppError(422,'REWORK_ROLL_DUPLICATE','Rework updates the selected existing rolls; new roll records cannot be added.');
    if(!isRework&&reworkAllocations.length) throw new AppError(422,'NOT_REWORK_ASSIGNMENT','Rework allocations are only available on a rework assignment.');
    if(isRework&&good>0&&!reworkAllocations.length) throw new AppError(422,'REWORK_ALLOCATION_REQUIRED','Allocate all good metres to the selected rework rolls.');
    if(isRework&&good===0&&reworkAllocations.length) throw new AppError(422,'REWORK_ALLOCATION_MISMATCH','A log with no good output cannot allocate rework metres.');
    if(isRework&&Math.abs(allocationTotal-good)>0.005) throw new AppError(422,'REWORK_ALLOCATION_MISMATCH','All good rework metres must be allocated to the selected rolls.');
    if(isRework){
      const selected=await client.query(`SELECT ar.roll_id,r.roll_no,r.length_meters,ar.source_inspection_id,
        COALESCE((SELECT sum(a2.allocated_meters) FROM production.rework_roll_log_allocations a2 JOIN production.production_logs pl2 USING(production_log_id) JOIN production.machine_assignment_rework_rolls ar2 ON ar2.machine_assignment_id=pl2.machine_assignment_id AND ar2.roll_id=a2.roll_id WHERE a2.roll_id=ar.roll_id AND ar2.source_inspection_id=ar.source_inspection_id),0) allocated_meters
        FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE ar.machine_assignment_id=$1 FOR UPDATE OF r`,[id]);
      const byId=new Map(selected.rows.map(row=>[String(row.roll_id),row]));
      for(const allocation of reworkAllocations){const target=byId.get(String(allocation.rollId));if(!target)throw new AppError(422,'INVALID_REWORK_ROLL','Choose a roll selected for this rework assignment.');if(Number(target.allocated_meters)+Number(allocation.meters)>Number(target.length_meters))throw new AppError(422,'REWORK_OUTPUT_EXCEEDED',`Rework output exceeds ${target.roll_no}'s remaining ${Number(target.length_meters)-Number(target.allocated_meters)} metres.`);}
    }
    if(a.replacement_request_id){
      const replacement=await client.query(`SELECT q.status,r.length_meters AS target_meters,
        COALESCE((SELECT sum(pl.good_meters) FROM production.production_logs pl WHERE pl.replacement_request_id=q.replacement_request_id),0) AS produced_meters
        FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id
        WHERE q.replacement_request_id=$1 AND q.job_id=$2 FOR UPDATE OF q`,[a.replacement_request_id,a.job_id]);
      if(!replacement.rowCount||replacement.rows[0].status!=='ISSUED')throw new AppError(409,'REPLACEMENT_MATERIALS_NOT_ISSUED','Replacement material must be approved and issued before logging this production.');
      if(Number(replacement.rows[0].produced_meters)+good>Number(replacement.rows[0].target_meters))throw new AppError(422,'REPLACEMENT_OUTPUT_EXCEEDED','Net good output cannot exceed the rejected roll replacement quantity.');
    }
    const result=await client.query(`INSERT INTO production.production_logs(machine_assignment_id,worker_id,shift_id,produced_meters,waste_meters,downtime_minutes,remarks,client_request_id,replacement_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(worker_id,client_request_id) DO NOTHING RETURNING *`,[id,w.worker_id,a.shift_id,produced,waste,downtime,remarks||null,requestKey,a.replacement_request_id]);
    if(!result.rowCount){const prior=await client.query('SELECT * FROM production.production_logs WHERE worker_id=$1 AND client_request_id=$2',[w.worker_id,requestKey]);const priorRolls=await client.query('SELECT roll_id,roll_no,length_meters,weight_kg,current_status FROM production.rolls WHERE production_log_id=$1 ORDER BY roll_id',[prior.rows[0].production_log_id]);return {log:prior.rows[0],rolls:priorRolls.rows,duplicate:true};}
    if(isRework) for(const allocation of reworkAllocations) await client.query(`INSERT INTO production.rework_roll_log_allocations(production_log_id,roll_id,allocated_meters) VALUES($1,$2,$3)`,[result.rows[0].production_log_id,Number(allocation.rollId),Number(allocation.meters)]);
    const createdRolls=[];
    for(const roll of rolls){const saved=await client.query(`INSERT INTO production.rolls(order_item_id,job_id,production_log_id,machine_id,shift_id,produced_by_worker_id,length_meters,weight_kg,notes,replacement_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING roll_id,roll_no,length_meters,weight_kg,current_status`,[a.order_item_id,a.job_id,result.rows[0].production_log_id,a.machine_id,a.shift_id,w.worker_id,Number(roll.lengthMeters),roll.weightKg==null?null:Number(roll.weightKg),typeof roll.notes==='string'?roll.notes.trim().slice(0,300)||null:null,a.replacement_request_id]);createdRolls.push(saved.rows[0]);}
    return {log:result.rows[0],rolls:createdRolls,duplicate:false};
  });}catch(e){businessConflict(e);}
}
async function productionLogs(userId,query={}){
  const w=await workerFor(userId),{limit,offset}=paging(query),values=[w.worker_id],filters=['pl.worker_id=$1'];
  const from=dateFilter(query.from,'Start date'),to=dateFilter(query.to,'End date');if(from&&to&&from>to)throw new AppError(400,'VALIDATION_ERROR','Start date must not be after end date.');
  if(from){values.push(from);filters.push(`pl.logged_at >= $${values.length}::date`);}if(to){values.push(to);filters.push(`pl.logged_at < ($${values.length}::date + INTERVAL '1 day')`);}
  if(query.jobId){values.push(positiveId(query.jobId,'Job ID'));filters.push(`j.job_id=$${values.length}`);}
  values.push(limit,offset);
  const rows=await pool.query(`SELECT pl.production_log_id,pl.logged_at,pl.produced_meters,pl.good_meters,pl.waste_meters,pl.downtime_minutes,pl.remarks,j.job_id,j.job_no,j.stage,m.machine_code,m.machine_name,sh.shift_name,
    (ma.status NOT IN ('COMPLETED','CANCELLED') AND j.status NOT IN ('COMPLETED','CANCELLED')
      AND NOT EXISTS(SELECT 1 FROM production.rework_roll_log_allocations a WHERE a.production_log_id=pl.production_log_id)
      AND NOT EXISTS(SELECT 1 FROM production.rolls r WHERE r.production_log_id=pl.production_log_id AND (
        r.current_status<>'PENDING_QC'
        OR EXISTS(SELECT 1 FROM quality.inspections i WHERE i.roll_id=r.roll_id)
        OR EXISTS(SELECT 1 FROM dispatch.shipment_items si WHERE si.roll_id=r.roll_id)
        OR EXISTS(SELECT 1 FROM production.machine_assignment_rework_rolls ar WHERE ar.roll_id=r.roll_id)
        OR EXISTS(SELECT 1 FROM production.replacement_material_requests q WHERE q.rejected_roll_id=r.roll_id)
      ))) AS can_delete,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',r.roll_id,'roll_no',r.roll_no,'length_meters',r.length_meters,'current_status',r.current_status) ORDER BY r.roll_id)
      FROM production.rolls r WHERE r.production_log_id=pl.production_log_id),'[]'::jsonb) AS rolls
    FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id)
    JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id WHERE ${filters.join(' AND ')}
    ORDER BY pl.logged_at DESC,pl.production_log_id DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  return {logs:rows.rows,limit,offset};
}
async function deleteProductionLog(userId,logId){
  const id=positiveId(logId,'Production log ID');
  try{return await transaction(async client=>{
    await setActor(client,userId);
    const worker=await workerFor(userId,client,true);
    const result=await client.query(`SELECT pl.*,ma.status AS assignment_status,j.status AS job_status
      FROM production.production_logs pl
      JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id)
      WHERE pl.production_log_id=$1 AND pl.worker_id=$2
      FOR UPDATE OF pl,ma,j`,[id,worker.worker_id]);
    if(!result.rowCount)throw new AppError(404,'NOT_FOUND','Production log was not found for your worker account.');
    const log=result.rows[0];
    if(['COMPLETED','CANCELLED'].includes(log.assignment_status)||['COMPLETED','CANCELLED'].includes(log.job_status)){
      throw new AppError(409,'PRODUCTION_LOG_LOCKED','Production history cannot be deleted after its assignment or job is closed.');
    }
    const protectedRecords=await client.query(`SELECT
      EXISTS(SELECT 1 FROM production.rolls r WHERE r.production_log_id=$1 AND r.current_status<>'PENDING_QC') AS processed_roll,
      EXISTS(SELECT 1 FROM quality.inspections i JOIN production.rolls r USING(roll_id) WHERE r.production_log_id=$1) AS inspected_roll,
      EXISTS(SELECT 1 FROM dispatch.shipment_items si JOIN production.rolls r USING(roll_id) WHERE r.production_log_id=$1) AS dispatched_roll,
      EXISTS(SELECT 1 FROM production.machine_assignment_rework_rolls ar JOIN production.rolls r USING(roll_id) WHERE r.production_log_id=$1) AS assigned_for_rework,
      EXISTS(SELECT 1 FROM production.replacement_material_requests q JOIN production.rolls r ON r.roll_id=q.rejected_roll_id WHERE r.production_log_id=$1) AS linked_replacement,
      EXISTS(SELECT 1 FROM production.rework_roll_log_allocations a WHERE a.production_log_id=$1) AS rework_output`,[id]);
    if(Object.values(protectedRecords.rows[0]).some(Boolean)){
      throw new AppError(409,'PRODUCTION_LOG_LOCKED','This log is connected to quality, rework, dispatch, or replacement records and cannot be deleted.');
    }
    const rolls=await client.query(`SELECT roll_id FROM production.rolls WHERE production_log_id=$1 FOR UPDATE`,[id]);
    await client.query(`INSERT INTO audit.change_log(actor_user_id,action,schema_name,table_name,record_key,old_data)
      VALUES($1,'DELETE','production','production_logs',$2,$3::jsonb)`,[userId,String(id),JSON.stringify(log)]);
    await client.query(`DELETE FROM production.rolls WHERE production_log_id=$1`,[id]);
    await client.query(`DELETE FROM production.production_logs WHERE production_log_id=$1 AND worker_id=$2`,[id,worker.worker_id]);
    return {production_log_id:id,deleted_rolls:rolls.rowCount};
  });}catch(error){businessConflict(error);}
}
async function productionLogDetail(userId,logId){const w=await workerFor(userId);const result=await pool.query(`SELECT pl.*,j.job_no,j.stage,m.machine_code,m.machine_name,sh.shift_name,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',r.roll_id,'roll_no',r.roll_no,'length_meters',r.length_meters,'weight_kg',r.weight_kg,'current_status',r.current_status) ORDER BY r.roll_id) FROM production.rolls r WHERE r.production_log_id=pl.production_log_id),'[]'::jsonb) AS rolls
  FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id
  WHERE pl.production_log_id=$1 AND pl.worker_id=$2`,[positiveId(logId,'Production log ID'),w.worker_id]);if(!result.rowCount)throw new AppError(404,'NOT_FOUND','Production log was not found.');return result.rows[0];}

module.exports={profile,dashboard,attendance,attendanceDetail,checkIn,checkOut,jobs,jobDetail,jobProgress,assignmentAction,machineList,reportBreakdown,createProductionLog,productionLogs,deleteProductionLog,productionLogDetail};

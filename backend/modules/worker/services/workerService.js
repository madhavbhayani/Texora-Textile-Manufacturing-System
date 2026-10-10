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
    w.wage_type,w.daily_rate,w.hourly_rate,w.overtime_multiplier,w.joined_on,w.is_active,
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
  if (error.code === '23505') throw new AppError(409, 'CONFLICT', 'This action conflicts with an existing record. Refresh and try again.');
  if (error.code === '42501') throw new AppError(403, 'FORBIDDEN', 'You are not permitted to perform this operation.');
  if (error.code === 'P0001') throw new AppError(422, 'BUSINESS_RULE_VIOLATION', error.message.replace(/^ERROR:\s*/i, '').split('\n')[0]);
  if (error.code === '23514' || error.code === '23503' || error.code === '22003' || error.code === '22007') throw new AppError(422, 'BUSINESS_RULE_VIOLATION', 'The submitted values conflict with current production or attendance rules.');
  throw error;
}

async function profile(userId) {
  const worker = await workerFor(userId);
  const shift = worker.default_shift_id ? (await pool.query('SELECT shift_id,shift_name,start_time,end_time FROM master.shifts WHERE shift_id=$1 AND is_active', [worker.default_shift_id])).rows[0] : null;
  return { ...worker, default_shift: shift || null };
}
async function dashboard(userId) {
  const w = await workerFor(userId);
  const [attendance, current, recent, wage, alerts] = await Promise.all([
    pool.query(`SELECT a.*,s.shift_name FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id
      WHERE a.worker_id=$1 AND a.work_date=CURRENT_DATE ORDER BY a.check_in DESC NULLS LAST LIMIT 1`, [w.worker_id]),
    pool.query(`SELECT ma.machine_assignment_id,ma.status AS assignment_status,ma.assigned_at,ma.started_at,j.job_id,j.job_no,j.stage,j.status AS job_status,j.planned_meters,
      m.machine_code,m.machine_name,m.status AS machine_status,sh.shift_name,
      COALESCE(sum(pl.produced_meters),0) AS produced_meters,COALESCE(sum(pl.waste_meters),0) AS waste_meters,COALESCE(sum(pl.downtime_minutes),0) AS downtime_minutes
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=ma.shift_id
      LEFT JOIN production.production_logs pl ON pl.machine_assignment_id=ma.machine_assignment_id
      WHERE jwa.worker_id=$1 AND jwa.unassigned_at IS NULL AND (jwa.ended_at IS NULL OR ma.status='PAUSED') AND ma.status IN ('ASSIGNED','RUNNING','PAUSED')
      GROUP BY ma.machine_assignment_id,j.job_id,m.machine_id,sh.shift_id ORDER BY ma.assigned_at DESC LIMIT 1`, [w.worker_id]),
    pool.query(`SELECT pl.production_log_id,pl.logged_at,pl.produced_meters,pl.waste_meters,pl.downtime_minutes,pl.remarks,j.job_no,m.machine_code
      FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id)
      WHERE pl.worker_id=$1 ORDER BY pl.logged_at DESC LIMIT 5`, [w.worker_id]),
    pool.query(`SELECT COALESCE(sum(wage_amount),0) AS calculated_amount,count(*) FILTER(WHERE work_date >= date_trunc('month',CURRENT_DATE)::date) AS month_days,
      COALESCE(sum(wage_amount) FILTER(WHERE work_date >= date_trunc('month',CURRENT_DATE)::date),0) AS month_amount
      FROM hr.attendance WHERE worker_id=$1 AND work_date >= date_trunc('month',CURRENT_DATE)::date`, [w.worker_id]),
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
  const wageSummary = wage.rows[0];
  return { worker: { employee_code: w.employee_code, full_name: w.full_name }, attendance: activeAttendance,
    current_job: currentJob, wage: { wage_type: w.wage_type, calculated_attendance_wages: wageSummary.calculated_amount,
      current_month_calculated_wages: wageSummary.month_amount, current_month_attendance_days: Number(wageSummary.month_days) },
    recent_logs: recent.rows, alerts: notices };
}

async function attendance(userId, query = {}) {
  const w = await workerFor(userId), { limit, offset } = paging(query);
  const values = [w.worker_id], filters = ['a.worker_id=$1'];
  const from=dateFilter(query.from,'Start date'),to=dateFilter(query.to,'End date');
  if (from) { values.push(from); filters.push(`a.work_date >= $${values.length}::date`); }
  if (to) { values.push(to); filters.push(`a.work_date <= $${values.length}::date`); }
  if (from&&to&&from>to) throw new AppError(400,'VALIDATION_ERROR','Start date must not be after end date.');
  values.push(limit, offset);
  const [result, openAttendance] = await Promise.all([pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.wage_amount,a.remarks,s.shift_name
    FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id WHERE ${filters.join(' AND ')}
    ORDER BY a.work_date DESC,a.check_in DESC NULLS LAST LIMIT $${values.length - 1} OFFSET $${values.length}`, values), pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.wage_amount,a.remarks,s.shift_name
    FROM hr.attendance a JOIN master.shifts s ON s.shift_id=a.shift_id WHERE a.worker_id=$1 AND a.check_in IS NOT NULL AND a.check_out IS NULL
    ORDER BY a.check_in DESC LIMIT 1`, [w.worker_id])]);
  return { records: result.rows, openAttendance: openAttendance.rows[0] || null, limit, offset };
}
async function attendanceDetail(userId, attendanceId) {
  const w = await workerFor(userId);
  const result = await pool.query(`SELECT a.attendance_id,a.work_date,a.status,a.check_in,a.check_out,a.regular_hours,a.overtime_hours,a.wage_amount,a.remarks,s.shift_name
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

async function wageSummary(userId, query = {}) {
  const w = await workerFor(userId);
  const requestedFrom=dateFilter(query.from,'Start date'),requestedTo=dateFilter(query.to,'End date');
  const dates=await pool.query("SELECT date_trunc('month',CURRENT_DATE)::date AS from_date,CURRENT_DATE AS to_date");
  const from=requestedFrom||String(dates.rows[0].from_date).slice(0,10),to=requestedTo||String(dates.rows[0].to_date).slice(0,10);
  if(from>to)throw new AppError(400,'VALIDATION_ERROR','Start date must not be after end date.');
  const attendanceResult = await pool.query(`SELECT count(*) AS days,count(*) FILTER(WHERE status='PRESENT') AS present_days,
    count(*) FILTER(WHERE status='HALF_DAY') AS half_days,count(*) FILTER(WHERE status='ABSENT') AS absent_days,count(*) FILTER(WHERE status='LEAVE') AS leave_days,
    COALESCE(sum(regular_hours),0) AS regular_hours,COALESCE(sum(overtime_hours),0) AS overtime_hours,COALESCE(sum(wage_amount),0) AS calculated_attendance_wages
    FROM hr.attendance WHERE worker_id=$1 AND work_date BETWEEN $2::date AND $3::date`, [w.worker_id, from, to]);
  const statements = await pool.query(`SELECT count(*) AS count,COALESCE(sum(gross_amount),0) AS gross_amount,COALESCE(sum(deductions),0) AS deductions,
    COALESCE(sum(net_amount),0) AS net_amount,COALESCE(sum(net_amount) FILTER(WHERE status='PAID'),0) AS paid_amount,
    COALESCE(sum(net_amount) FILTER(WHERE status='PENDING'),0) AS pending_amount
    FROM hr.wage_payments WHERE worker_id=$1 AND period_start >= $2::date AND period_end <= $3::date AND status <> 'CANCELLED'`, [w.worker_id, from, to]);
  const settings = await pool.query(`SELECT setting_key,setting_value FROM core.app_settings WHERE setting_key IN ('standard_shift_hours','overtime_multiplier')`);
  const setting = Object.fromEntries(settings.rows.map(row => [row.setting_key, row.setting_value]));
  return { period: { from, to }, wage_type: w.wage_type, rate: w.wage_type === 'DAILY' ? w.daily_rate : w.hourly_rate,
    overtime_multiplier: w.overtime_multiplier, standard_shift_hours: setting.standard_shift_hours || '8',
    attendance: attendanceResult.rows[0], statements: statements.rows[0], statement_finalized: Number(statements.rows[0].count) > 0 };
}
async function wages(userId, query = {}) {
  const w = await workerFor(userId), { limit, offset } = paging(query);
  const result = await pool.query(`SELECT wage_payment_id,wage_no,period_start,period_end,gross_amount,deductions,net_amount,status,paid_at,payment_method,created_at
    FROM hr.wage_payments WHERE worker_id=$1 ORDER BY period_end DESC,wage_payment_id DESC LIMIT $2 OFFSET $3`, [w.worker_id, limit, offset]);
  return { statements: result.rows, limit, offset };
}
async function wageDetail(userId, wageId) {
  const w = await workerFor(userId);
  const result = await pool.query(`SELECT wage_payment_id,wage_no,period_start,period_end,gross_amount,deductions,net_amount,status,paid_at,payment_method,created_at
    FROM hr.wage_payments WHERE wage_payment_id=$1 AND worker_id=$2`, [positiveId(wageId, 'Wage statement ID'), w.worker_id]);
  if (!result.rowCount) throw new AppError(404, 'NOT_FOUND', 'Wage statement was not found.'); return result.rows[0];
}

const jobSelect = `SELECT j.job_id,j.job_no,j.order_item_id,o.order_no,ft.fabric_name,c.colour_name,j.stage,j.planned_meters,j.status AS job_status,
  ma.machine_assignment_id,ma.status AS assignment_status,ma.assigned_at,ma.started_at,ma.ended_at,
  m.machine_id,m.machine_code,m.machine_name,m.status AS machine_status,sh.shift_id,sh.shift_name,sh.start_time,sh.end_time,
  COALESCE(sum(pl.produced_meters),0) AS produced_meters,COALESCE(sum(pl.waste_meters),0) AS waste_meters,
  COALESCE(sum(pl.downtime_minutes),0) AS downtime_minutes,
  GREATEST(j.planned_meters-COALESCE(sum(pl.produced_meters),0),0) AS remaining_meters
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
  const logs = await pool.query(`SELECT production_log_id,logged_at,produced_meters,waste_meters,downtime_minutes,remarks FROM production.production_logs
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
      await client.query('SELECT production.set_assignment_running($1,$2)', [id, userId]);
    } else if (action === 'stop') {
      if (a.assignment_status !== 'RUNNING') throw new AppError(409, 'ASSIGNMENT_NOT_RUNNING', 'Only a running assignment can be paused.');
      await client.query('SELECT production.stop_assignment($1,$2,FALSE)', [id, userId]);
    } else if (action === 'complete') {
      if (['COMPLETED','CANCELLED'].includes(a.job_status)) throw new AppError(409, 'JOB_CLOSED', 'This job is already closed.');
      const output = await client.query('SELECT COALESCE(sum(produced_meters),0) AS produced FROM production.production_logs WHERE machine_assignment_id=$1', [id]);
      const plan = await client.query('SELECT planned_meters FROM production.jobs WHERE job_id=$1', [a.job_id]);
      if (Number(output.rows[0].produced) < Number(plan.rows[0].planned_meters)) throw new AppError(422, 'PRODUCTION_INCOMPLETE', 'The job cannot be completed until recorded good output meets the planned metres.');
      await client.query('SELECT production.stop_assignment($1,$2,TRUE)', [id, userId]);
    }
    return (await client.query(`SELECT ma.machine_assignment_id,ma.status AS assignment_status,j.job_id,j.job_no,j.status AS job_status,m.machine_status
      FROM production.machine_assignments ma JOIN production.jobs j USING(job_id) JOIN LATERAL (SELECT status AS machine_status FROM master.machines WHERE machine_id=ma.machine_id) m ON TRUE WHERE ma.machine_assignment_id=$1`, [id])).rows[0];
  }); } catch (e) { businessConflict(e); }
}
async function machineList(userId) {
  const w=await workerFor(userId); return (await pool.query(`SELECT m.machine_id,m.machine_code,m.machine_name,m.stage,m.status,
    j.job_id,j.job_no,j.status AS job_status,ma.machine_assignment_id,ma.status AS assignment_status,sh.shift_name,
    COALESCE((SELECT sum(produced_meters) FROM production.production_logs pl WHERE pl.machine_assignment_id=ma.machine_assignment_id),0) AS produced_meters,j.planned_meters
    FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
    JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=ma.shift_id
    WHERE jwa.worker_id=$1 AND jwa.unassigned_at IS NULL ORDER BY ma.assigned_at DESC`,[w.worker_id])).rows;
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
  const rolls=Array.isArray(input.rolls)?input.rolls:[];
  if(rolls.length>100) throw new AppError(400,'VALIDATION_ERROR','A log can include up to 100 rolls.');
  for(const roll of rolls) if(!Number.isFinite(Number(roll.lengthMeters))||Number(roll.lengthMeters)<=0||roll.lengthMeters>10000000||roll.weightKg!=null&&(!Number.isFinite(Number(roll.weightKg))||Number(roll.weightKg)<=0)) throw new AppError(400,'VALIDATION_ERROR','Each roll requires a positive length and optional positive weight.');
  const rollTotal=rolls.reduce((sum,r)=>sum+Number(r.lengthMeters),0);
  if(rollTotal>produced) throw new AppError(422,'ROLL_OUTPUT_EXCEEDED','Roll lengths cannot exceed the good production metres.');
  try{return await transaction(async client=>{
    await setActor(client,userId);const w=await workerFor(userId,client,true),id=assignmentId;
    const existing=await client.query(`SELECT * FROM production.production_logs WHERE worker_id=$1 AND client_request_id=$2`,[w.worker_id,requestKey]);
    if(existing.rowCount){const existingRolls=await client.query(`SELECT roll_id,roll_no,length_meters,weight_kg,current_status FROM production.rolls WHERE production_log_id=$1 ORDER BY roll_id`,[existing.rows[0].production_log_id]);return {log:existing.rows[0],rolls:existingRolls.rows,duplicate:true};}
    const assignment=await client.query(`SELECT ma.machine_assignment_id,ma.job_id,ma.machine_id,ma.shift_id,ma.status,m.status AS machine_status,j.order_item_id
      FROM production.job_worker_assignments jwa JOIN production.machine_assignments ma USING(machine_assignment_id)
      JOIN master.machines m USING(machine_id) JOIN production.jobs j USING(job_id)
      WHERE jwa.machine_assignment_id=$1 AND jwa.worker_id=$2 AND jwa.ended_at IS NULL AND ma.status='RUNNING' FOR UPDATE OF ma,jwa,m`,[id,w.worker_id]);
    if(!assignment.rowCount) throw new AppError(409,'ASSIGNMENT_NOT_RUNNING','You must be actively assigned to a running machine to record production.');
    if(['BREAKDOWN','MAINTENANCE'].includes(assignment.rows[0].machine_status)) throw new AppError(409,'MACHINE_UNAVAILABLE','Production cannot be recorded while the machine is unavailable.');
    const a=assignment.rows[0];
    const result=await client.query(`INSERT INTO production.production_logs(machine_assignment_id,worker_id,shift_id,produced_meters,waste_meters,downtime_minutes,remarks,client_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(worker_id,client_request_id) DO NOTHING RETURNING *`,[id,w.worker_id,a.shift_id,produced,waste,downtime,remarks||null,requestKey]);
    if(!result.rowCount){const prior=await client.query('SELECT * FROM production.production_logs WHERE worker_id=$1 AND client_request_id=$2',[w.worker_id,requestKey]);const priorRolls=await client.query('SELECT roll_id,roll_no,length_meters,weight_kg,current_status FROM production.rolls WHERE production_log_id=$1 ORDER BY roll_id',[prior.rows[0].production_log_id]);return {log:prior.rows[0],rolls:priorRolls.rows,duplicate:true};}
    const createdRolls=[];
    for(const roll of rolls){const saved=await client.query(`INSERT INTO production.rolls(order_item_id,job_id,production_log_id,machine_id,shift_id,produced_by_worker_id,length_meters,weight_kg,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING roll_id,roll_no,length_meters,weight_kg,current_status`,[a.order_item_id,a.job_id,result.rows[0].production_log_id,a.machine_id,a.shift_id,w.worker_id,Number(roll.lengthMeters),roll.weightKg==null?null:Number(roll.weightKg),typeof roll.notes==='string'?roll.notes.trim().slice(0,300)||null:null]);createdRolls.push(saved.rows[0]);}
    return {log:result.rows[0],rolls:createdRolls,duplicate:false};
  });}catch(e){businessConflict(e);}
}
async function productionLogs(userId,query={}){
  const w=await workerFor(userId),{limit,offset}=paging(query),values=[w.worker_id],filters=['pl.worker_id=$1'];
  const from=dateFilter(query.from,'Start date'),to=dateFilter(query.to,'End date');if(from&&to&&from>to)throw new AppError(400,'VALIDATION_ERROR','Start date must not be after end date.');
  if(from){values.push(from);filters.push(`pl.logged_at >= $${values.length}::date`);}if(to){values.push(to);filters.push(`pl.logged_at < ($${values.length}::date + INTERVAL '1 day')`);}
  if(query.jobId){values.push(positiveId(query.jobId,'Job ID'));filters.push(`j.job_id=$${values.length}`);}
  values.push(limit,offset);
  const rows=await pool.query(`SELECT pl.production_log_id,pl.logged_at,pl.produced_meters,pl.waste_meters,pl.downtime_minutes,pl.remarks,j.job_id,j.job_no,j.stage,m.machine_code,m.machine_name,sh.shift_name,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',r.roll_id,'roll_no',r.roll_no,'length_meters',r.length_meters,'current_status',r.current_status) ORDER BY r.roll_id)
      FROM production.rolls r WHERE r.production_log_id=pl.production_log_id),'[]'::jsonb) AS rolls
    FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id)
    JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id WHERE ${filters.join(' AND ')}
    ORDER BY pl.logged_at DESC,pl.production_log_id DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  return {logs:rows.rows,limit,offset};
}
async function productionLogDetail(userId,logId){const w=await workerFor(userId);const result=await pool.query(`SELECT pl.*,j.job_no,j.stage,m.machine_code,m.machine_name,sh.shift_name,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('roll_id',r.roll_id,'roll_no',r.roll_no,'length_meters',r.length_meters,'weight_kg',r.weight_kg,'current_status',r.current_status) ORDER BY r.roll_id) FROM production.rolls r WHERE r.production_log_id=pl.production_log_id),'[]'::jsonb) AS rolls
  FROM production.production_logs pl JOIN production.machine_assignments ma USING(machine_assignment_id) JOIN production.jobs j USING(job_id) JOIN master.machines m USING(machine_id) JOIN master.shifts sh ON sh.shift_id=pl.shift_id
  WHERE pl.production_log_id=$1 AND pl.worker_id=$2`,[positiveId(logId,'Production log ID'),w.worker_id]);if(!result.rowCount)throw new AppError(404,'NOT_FOUND','Production log was not found.');return result.rows[0];}

module.exports={profile,dashboard,attendance,attendanceDetail,checkIn,checkOut,wageSummary,wages,wageDetail,jobs,jobDetail,jobProgress,assignmentAction,machineList,reportBreakdown,createProductionLog,productionLogs,productionLogDetail};

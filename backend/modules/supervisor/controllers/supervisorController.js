'use strict';
const service = require('../services/supervisorService');
const AppError = require('../../../shared/errors/AppError');

function send(fn,status=200,key='result') { return async(req,res,next)=>{try{const value=await fn(req);res.status(status).json({success:true,data:{[key]:value}});}catch(error){next(error);}}; }
function object(value,label='Request body') { if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(400,'VALIDATION_ERROR',`${label} must be an object.`);return value; }
const actor=(req)=>req.auth.userId;
module.exports={
 dashboard:send(req=>service.dashboard(actor(req)),200,'dashboard'),
 handoffs:send(req=>service.handoffs(actor(req),req.query),200,'handoffs'),handoff:send(req=>service.handoff(actor(req),req.params.id),200,'handoff'),
 accept:send(req=>service.transitionHandoff(actor(req),req.params.id,'ACCEPTED'),200,'handoff'),
 reject:send(req=>service.transitionHandoff(actor(req),req.params.id,'REJECTED',object(req.body).reason),200,'handoff'),
 hold:send(req=>service.transitionHandoff(actor(req),req.params.id,'ON_HOLD',object(req.body).reason),200,'handoff'),
 createJob:send(req=>service.createJob(actor(req),req.params.id),201,'job'),
 jobs:send(req=>service.jobs(actor(req),req.query),200,'jobs'),job:send(req=>service.job(actor(req),req.params.id),200,'job'),
 assignMachine:send(req=>service.assignMachine(actor(req),req.params.id,object(req.body)),201,'assignment'),
 workers:send(req=>service.workers(req.query.stage),200,'workers'),createWorker:send(req=>service.createWorker(actor(req),object(req.body)),201,'provisionedWorker'),updateWorkerShift:send(req=>service.updateWorkerShift(actor(req),req.params.id,object(req.body).shiftId),200,'worker'),shifts:send(()=>service.shifts(),200,'shifts'),assignWorker:send(req=>service.assignWorker(actor(req),req.params.id,object(req.body).workerId,req.body.notes),201,'assignment'),unassignWorker:send(req=>service.unassignWorker(actor(req),req.params.id),200,'assignment'),
 machines:send(()=>service.machines(),200,'machines'),createMachine:send(req=>service.createMachine(actor(req),object(req.body)),201,'machine'),machine:send(req=>service.machine(req.params.id),200,'machine'),machineHistory:send(req=>service.machineHistory(req.params.id),200,'events'),
 statusEvent:send(req=>service.statusEvent(actor(req),req.params.id,object(req.body)),201,'event'),breakdowns:send(()=>service.breakdowns(),200,'breakdowns'),logs:send(req=>service.logs(actor(req),req.params.id),200,'logs'),
 rolls:send(req=>service.rolls(actor(req),req.query),200,'rolls'),registerRoll:send(req=>service.createRoll(actor(req),object(req.body)),201,'roll'),
 pendingQuality:send(req=>service.qualityPending(actor(req),req.query),200,'rolls'),rollDetail:send(req=>service.rollDetail(actor(req),req.params.id),200,'roll'),defectTypes:send(()=>service.defectTypes(),200,'defectTypes'),inspect:send(req=>service.inspectRoll(actor(req),req.params.id,object(req.body)),201,'inspection'),
 inspections:send(req=>service.inspections(actor(req),req.query),200,'inspections'),inspection:send(req=>service.inspectionDetail(actor(req),req.params.id),200,'inspection'),
 rework:send(req=>service.rolls(actor(req),{...req.query,state:'rework'}),200,'rolls'),rejected:send(req=>service.rolls(actor(req),{...req.query,state:'rejected'}),200,'rolls'),
 productionReport:send(req=>service.report(actor(req),'production',req.query),200,'report'),qualityReport:send(req=>service.report(actor(req),'quality',req.query),200,'report'),machineReport:send(req=>service.report(actor(req),'machines',req.query),200,'report'),workerReport:send(req=>service.report(actor(req),'workers',req.query),200,'report'),
};

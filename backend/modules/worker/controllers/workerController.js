'use strict';
const service = require('../services/workerService');
const AppError = require('../../../shared/errors/AppError');
const actor = req => req.auth.userId;
function send(fn, status=200, key='result') { return async(req,res,next)=>{try{const data=await fn(req);res.status(status).json({success:true,data:{[key]:data}});}catch(error){next(error);}}; }
function body(req){if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AppError(400,'VALIDATION_ERROR','Request body must be an object.');return req.body;}
module.exports={
 dashboard:send(req=>service.dashboard(actor(req)),200,'dashboard'),profile:send(req=>service.profile(actor(req)),200,'profile'),
 attendance:send(req=>service.attendance(actor(req),req.query),200,'attendance'),attendanceDetail:send(req=>service.attendanceDetail(actor(req),req.params.attendanceId),200,'attendance'),
 checkIn:send(req=>service.checkIn(actor(req)),201,'attendance'),checkOut:send(req=>service.checkOut(actor(req)),200,'attendance'),
 wageSummary:send(req=>service.wageSummary(actor(req),req.query),200,'summary'),wages:send(req=>service.wages(actor(req),req.query),200,'wages'),wageDetail:send(req=>service.wageDetail(actor(req),req.params.wagePaymentId),200,'wage'),
 jobs:send(req=>service.jobs(actor(req),req.query),200,'jobs'),jobDetail:send(req=>service.jobDetail(actor(req),req.params.jobId),200,'job'),jobProgress:send(req=>service.jobProgress(actor(req),req.params.jobId),200,'progress'),
 start:send(req=>service.assignmentAction(actor(req),req.params.assignmentId,'start'),200,'assignment'),stop:send(req=>service.assignmentAction(actor(req),req.params.assignmentId,'stop'),200,'assignment'),complete:send(req=>service.assignmentAction(actor(req),req.params.assignmentId,'complete'),200,'assignment'),
 machines:send(req=>service.machineList(actor(req)),200,'machines'),reportBreakdown:send(req=>service.reportBreakdown(actor(req),req.params.machineId,body(req)),201,'event'),
 createLog:send(req=>service.createProductionLog(actor(req),body(req)),201,'submission'),productionLogs:send(req=>service.productionLogs(actor(req),req.query),200,'productionLogs'),productionLogDetail:send(req=>service.productionLogDetail(actor(req),req.params.productionLogId),200,'productionLog'),
};

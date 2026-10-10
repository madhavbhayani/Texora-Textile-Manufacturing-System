'use strict';

const nodemailer = require('nodemailer');
const AppError = require('../errors/AppError');

let transporter = null;

function emailConfig() {
  const from = String(process.env.GMAIL || '').trim();
  const password = String(process.env.APP_PASSWORD || '').replace(/\s+/g, '');
  return { from, password };
}

async function initializeMailer() {
  const { from, password } = emailConfig();
  if (!from && !password) return { configured: false, connected: false };
  if (!from || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    transporter = null;
    return { configured: false, connected: false };
  }

  transporter = nodemailer.createTransport({
    service: 'gmail',
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    auth: { user: from, pass: password },
  });

  try {
    await transporter.verify();
    return { configured: true, connected: true };
  } catch {
    return { configured: true, connected: false };
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function sendWorkerCredentials({ to, fullName, employeeCode, temporaryPassword }) {
  const { from, password } = emailConfig();
  if (!transporter || !from || !password) {
    throw new AppError(503, 'WORKER_EMAIL_UNAVAILABLE', 'Worker account email is not configured. Ask an administrator to configure the Texora email service.');
  }

  const safeName = escapeHtml(fullName);
  const safeCode = escapeHtml(employeeCode);
  try {
    await transporter.sendMail({
      from: { name: 'Texora', address: from },
      to,
      subject: 'Your Texora worker account',
      text: [
        `Hello ${fullName},`,
        '',
        'A Texora worker account has been created for you.',
        `Employee code: ${employeeCode}`,
        `Login email: ${to}`,
        `Temporary password: ${temporaryPassword}`,
        '',
        'Sign in to Texora with this temporary password. You will be required to set a new personal password at first sign-in.',
        'If you were not expecting this account, contact your Texora administrator.',
      ].join('\n'),
      html: `<p>Hello ${safeName},</p><p>A Texora worker account has been created for you.</p><p><strong>Employee code:</strong> ${safeCode}<br><strong>Login email:</strong> ${escapeHtml(to)}<br><strong>Temporary password:</strong> <code>${escapeHtml(temporaryPassword)}</code></p><p>Sign in to Texora with this temporary password. You will be required to set a new personal password at first sign-in.</p><p>If you were not expecting this account, contact your Texora administrator.</p>`,
    });
  } catch {
    throw new AppError(503, 'WORKER_EMAIL_DELIVERY_FAILED', 'The worker account email could not be delivered. No account was created; check the email service and try again.');
  }
}

function closeMailer() {
  transporter?.close();
  transporter = null;
}

module.exports = { initializeMailer, sendWorkerCredentials, closeMailer };

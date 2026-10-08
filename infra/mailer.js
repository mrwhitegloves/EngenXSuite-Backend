import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// The one place that sends email. SMTP (Google Workspace with an App password by default), so
// the provider can be changed by changing environment variables only.

let transporter = null;

export function isMailConfigured() {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // 465 = TLS from the start; 587 upgrades with STARTTLS
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Send one email. Never throws: a mail problem must not break the request that caused it.
 * @param {{ to: string, subject: string, text: string, html?: string }} message
 * @returns {Promise<{ sent: boolean, reason?: 'not_configured' | 'failed' }>}
 */
export async function sendMail({ to, subject, text, html }) {
  if (!isMailConfigured()) return { sent: false, reason: 'not_configured' };
  try {
    await getTransporter().sendMail({
      from: env.MAIL_FROM || env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (error) {
    // The recipient address is personal data and is left out of the log on purpose.
    logger.error({ err: error, subject }, 'Email could not be sent');
    return { sent: false, reason: 'failed' };
  }
}

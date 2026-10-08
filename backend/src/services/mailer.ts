import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { getSenderCredentials, type SenderCredentials } from './senderService';

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
  accepted: boolean;
}

/**
 * One pooled transport per sender, created once and reused.
 * Building a transport per send would open a fresh TCP+TLS handshake every time
 * and cap throughput well below the configured rate limit.
 */
const transports = new Map<string, Transporter>();

function getTransport(creds: SenderCredentials): Transporter {
  const existing = transports.get(creds.id);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: { user: creds.user, pass: creds.pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 200,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  transports.set(creds.id, transport);
  return transport;
}

export interface SendEmailInput {
  senderId: string;
  to: string;
  subject: string;
  body: string;
}

export async function sendEmail(input: SendEmailInput): Promise<SendResult> {
  const creds = await getSenderCredentials(input.senderId);
  if (!creds) {
    throw new Error(`Sender ${input.senderId} not found or inactive`);
  }

  // DRY_RUN exercises the full claim / rate-limit / persist path without
  // touching SMTP, so a 1000-email load demo isn't capped by Ethereal itself.
  if (env.DRY_RUN) {
    return {
      messageId: `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      previewUrl: null,
      accepted: true,
    };
  }

  const transport = getTransport(creds);

  const info = await transport.sendMail({
    from: `"${creds.fromName}" <${creds.fromEmail}>`,
    to: input.to,
    subject: input.subject,
    text: htmlToText(input.body),
    html: wrapHtml(input.body),
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);

  return {
    messageId: info.messageId,
    previewUrl: typeof previewUrl === 'string' ? previewUrl : null,
    accepted: (info.accepted?.length ?? 0) > 0,
  };
}

/** Body arrives as plain text from the compose form; keep line breaks in HTML. */
function wrapHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br />');

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827;">${escaped}</body></html>`;
}

const htmlToText = (body: string) => body;

export async function closeAllTransports(): Promise<void> {
  for (const [id, transport] of transports) {
    try {
      transport.close();
    } catch (err) {
      logger.warn({ err, senderId: id }, 'Failed to close SMTP transport');
    }
  }
  transports.clear();
}

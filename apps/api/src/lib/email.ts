import type { Env } from '../env';
import { logger } from './logger';

/** One outgoing email. `text` is always set: every message has a plain-text version. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Files to attach, such as an invoice PDF. `content` is base64. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  /** The file's bytes, base64 encoded. */
  content: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export type SentEmail = EmailMessage;

/** Outbox of the test sender. Tests run in the Worker's isolate, so they can read it directly. */
export const sentEmails: SentEmail[] = [];

export const inMemoryEmailSender: EmailSender = {
  async send(message) {
    sentEmails.push(message);
  },
};

/** Local development: the message (including any link) goes to the log instead of a mailbox. */
export const loggingEmailSender: EmailSender = {
  async send({ to, subject, text }) {
    logger.info('email.dev_outbox', { to, subject, text });
  },
};

/**
 * Staging and production when no Resend key or sender address is configured. Never logs the body: reset links
 * are bearer credentials.
 */
export const unconfiguredEmailSender: EmailSender = {
  async send({ subject }) {
    logger.error('email.not_configured', { subject });
  },
};

const RESEND_TIMEOUT_MS = 10_000;
const RESEND_URL = 'https://api.resend.com/emails';

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Where replies go, for example a support inbox. */
  replyTo?: string;
  fetch?: typeof fetch;
}

/**
 * Sends through Resend. A failed response throws with the status only: the response body and
 * the message (which may hold a reset link) never reach logs or error messages.
 */
export function resendEmailSender(opts: ResendOptions): EmailSender {
  const doFetch = opts.fetch ?? fetch;
  const replyTo = opts.replyTo?.trim();
  return {
    async send({ to, subject, text, html, headers, attachments }) {
      const response = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: opts.from,
          to: [to],
          subject,
          text,
          ...(html ? { html } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
          ...(attachments && attachments.length > 0
            ? { attachments: attachments.map(({ filename, content }) => ({ filename, content })) }
            : {}),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Resend request failed with status ${response.status}`);
      }
    },
  };
}

export function emailSenderFor(
  env: Pick<Env, 'APP_ENV' | 'RESEND_API_KEY' | 'EMAIL_FROM' | 'EMAIL_REPLY_TO'>,
): EmailSender {
  if (env.APP_ENV === 'test') return inMemoryEmailSender;
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    return resendEmailSender({
      apiKey: env.RESEND_API_KEY,
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
    });
  }
  if (env.APP_ENV === 'development') return loggingEmailSender;
  return unconfiguredEmailSender;
}

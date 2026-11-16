import { env } from 'cloudflare:workers';
import { createDb } from '@knoqra/db';
import { describe, expect, it, vi } from 'vitest';
import { createAuth } from '../src/auth/auth';
import {
  type EmailSender,
  emailSenderFor,
  loggingEmailSender,
  resendEmailSender,
  unconfiguredEmailSender,
} from '../src/lib/email';
import { BASE, signUp, uniqueEmail } from './helpers';

const LINK = 'https://x/reset?token=SECRET';

describe('resendEmailSender', () => {
  it('posts to Resend with a bearer key', async () => {
    const f = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    await resendEmailSender({ apiKey: 'k', from: 'a@b.test', fetch: f }).send(
      'u@x.test',
      'Hi',
      'body',
    );
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'a@b.test',
      to: ['u@x.test'],
      subject: 'Hi',
      text: 'body',
    });
  });

  it('never leaks the body or link on failure', async () => {
    const f = vi.fn(async () => new Response(`boom: ${LINK}`, { status: 500 }));
    const sender = resendEmailSender({ apiKey: 'k', from: 'a@b.test', fetch: f });
    const error = await sender.send('u@x.test', 'Reset', LINK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Resend request failed with status 500');
    expect((error as Error).message).not.toMatch(/SECRET/);
  });
});

describe('emailSenderFor', () => {
  const base = { APP_ENV: 'production' as const };
  it('uses unconfigured without both Resend settings', () => {
    expect(emailSenderFor(base)).toBe(unconfiguredEmailSender);
    expect(emailSenderFor({ ...base, RESEND_API_KEY: 'k' })).toBe(unconfiguredEmailSender);
  });
  it('uses Resend when both are set', () => {
    const s = emailSenderFor({ ...base, RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.test' });
    expect(s).not.toBe(unconfiguredEmailSender);
  });
  it('keeps the logging sender for development', () => {
    expect(emailSenderFor({ APP_ENV: 'development' })).toBe(loggingEmailSender);
  });
});

describe('reset email timing', () => {
  it('responds before a slow sender finishes', async () => {
    const address = uniqueEmail('slow');
    await signUp(address);
    const pending: Promise<unknown>[] = [];
    let delivered = false;
    const slow: EmailSender = {
      async send() {
        await new Promise((r) => setTimeout(r, 2000));
        delivered = true;
      },
    };
    const { db, close } = createDb(env.DATABASE_URL as string);
    try {
      const auth = createAuth(env as never, db, {
        email: slow,
        waitUntil: (p) => {
          pending.push(p);
        },
      });
      const start = Date.now();
      const r = await auth.handler(
        new Request(`${BASE}/api/auth/request-password-reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ email: address, redirectTo: '/reset-password' }),
        }),
      );
      expect(r.status).toBe(200);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(delivered).toBe(false);
      await Promise.all(pending);
      expect(delivered).toBe(true);
    } finally {
      await close();
    }
  });
});

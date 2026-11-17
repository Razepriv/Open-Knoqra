import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import {
  citationHref,
  needsOttoSetup,
  ottoErrorMessage,
  ottoEyebrow,
  ottoKeyErrorMessage,
  ottoMood,
  streamOtto,
  takeEvents,
} from './otto';

const CONTACT = 'ct_0123456789abcdef0123456789abcdef';
const OTHER = 'ct_fedcba9876543210fedcba9876543210';

describe('citationHref', () => {
  it('links a contact citation to that contact', () => {
    expect(citationHref({ kind: 'contact', ref: OTHER }, CONTACT)).toBe(`/contacts/${OTHER}`);
    expect(citationHref({ kind: 'contact', ref: OTHER }, null)).toBe(`/contacts/${OTHER}`);
  });

  it("links a timeline citation to the draft's contact, or nowhere without one", () => {
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, CONTACT)).toBe(`/contacts/${CONTACT}`);
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, null)).toBeNull();
    expect(citationHref({ kind: 'timeline', ref: 'te_1' })).toBeNull();
  });

  it("links a task citation to the draft's contact, else to the task list", () => {
    expect(citationHref({ kind: 'task', ref: 'tk_1' }, CONTACT)).toBe(`/contacts/${CONTACT}`);
    expect(citationHref({ kind: 'task', ref: 'tk_1' }, null)).toBe('/tasks');
  });

  it('does not link a notification citation', () => {
    expect(citationHref({ kind: 'notification', ref: 'nt_1' }, CONTACT)).toBeNull();
    expect(citationHref({ kind: 'notification', ref: 'nt_1' }, null)).toBeNull();
  });

  it('never builds a link from a ref that is not a contact id', () => {
    expect(citationHref({ kind: 'contact', ref: '../settings' }, null)).toBeNull();
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, '//evil.example.test')).toBeNull();
  });
});

describe('ottoEyebrow', () => {
  it('labels each kind of output', () => {
    expect(ottoEyebrow({ kind: 'draft', channel: 'sms' })).toBe('DRAFT · SMS · NOT SENT');
    expect(ottoEyebrow({ kind: 'draft', channel: 'whatsapp' })).toBe('DRAFT · WHATSAPP · NOT SENT');
    expect(ottoEyebrow({ kind: 'draft', channel: null })).toBe('DRAFT · NOT SENT');
    expect(ottoEyebrow({ kind: 'brief', channel: null })).toBe('BRIEF');
    expect(ottoEyebrow({ kind: 'digest', channel: null })).toBe('WHAT YOU MISSED');
  });
});

describe('ottoErrorMessage', () => {
  it('names the daily limit and an outage plainly', () => {
    expect(ottoErrorMessage(new ApiError(429, 'x', 'quota_exceeded'))).toBe(
      "Otto has reached today's limit.",
    );
    expect(ottoErrorMessage(new ApiError(503, 'x', 'ai_unavailable'))).toBe(
      'Otto is unavailable right now. Try again in a minute.',
    );
  });

  it('explains a contact Otto cannot use and a lost connection', () => {
    expect(ottoErrorMessage(new ApiError(404, 'x', 'not_found'))).toBe(
      'We could not find that contact.',
    );
    expect(ottoErrorMessage(new ApiError(422, 'x', 'contact_archived'))).toBe(
      'Otto can only work with active contacts.',
    );
    expect(ottoErrorMessage(new NetworkError())).toBe(
      'We could not reach KNOQRA. Check your connection and try again.',
    );
  });

  it('never shows server text for anything else', () => {
    expect(ottoErrorMessage(new ApiError(500, 'stack trace here'))).toBe(
      'Otto could not answer. Try again.',
    );
    expect(ottoErrorMessage(new Error('boom'))).toBe('Otto could not answer. Try again.');
  });
});

describe('ottoMood', () => {
  it('thinks while pending, is happy with a result and idle otherwise', () => {
    expect(ottoMood({ pending: true, hasResult: true })).toBe('thinking');
    expect(ottoMood({ pending: false, hasResult: true })).toBe('happy');
    expect(ottoMood({ pending: false, hasResult: false })).toBe('idle');
  });
});

describe('Otto setup errors', () => {
  it('points to Settings when Otto is not connected or not in the plan', () => {
    const notConnected = new ApiError(409, 'x', 'otto_not_connected');
    const upgrade = new ApiError(402, 'x', 'otto_upgrade_required');
    expect(needsOttoSetup(notConnected)).toBe(true);
    expect(needsOttoSetup(upgrade)).toBe(true);
    expect(needsOttoSetup(new ApiError(429, 'x', 'quota_exceeded'))).toBe(false);
    expect(ottoErrorMessage(notConnected)).toBe('Connect Otto to OpenAI in Settings first.');
    expect(ottoErrorMessage(upgrade)).toContain('does not include Otto');
  });

  it('says busy, never a raw error, when the model is rate limited', () => {
    const busy = new ApiError(503, 'raw upstream words', 'ai_busy');
    expect(ottoErrorMessage(busy, true)).toBe(
      'Otto is busy right now (early access). Try again in a minute.',
    );
    expect(ottoErrorMessage(busy)).toBe('Otto is busy right now. Try again in a minute.');
    expect(ottoErrorMessage(busy, true)).not.toContain('raw');
  });

  it('words key save failures without server text', () => {
    expect(ottoKeyErrorMessage(new ApiError(400, 'server words', 'invalid_api_key'))).toBe(
      'OpenAI did not accept this key. Check it and try again.',
    );
    expect(ottoKeyErrorMessage(new ApiError(503, 'server words', 'ai_unavailable'))).toContain(
      'could not reach OpenAI',
    );
    expect(ottoKeyErrorMessage(new NetworkError())).toContain('could not reach KNOQRA');
  });
});

describe('streamed answers', () => {
  it('takes complete events and keeps the unfinished rest', () => {
    const { events, rest } = takeEvents(
      'event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"id":"od_1"}\n\nevent: del',
    );
    expect(events).toEqual([
      { event: 'delta', data: '{"text":"Hi"}' },
      { event: 'done', data: '{"id":"od_1"}' },
    ]);
    expect(rest).toBe('event: del');
  });

  function streamOf(chunks: string[], init: ResponseInit = {}) {
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' }, ...init },
    );
  }

  it('hands over each piece, then resolves with the stored draft', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      streamOf([
        'event: delta\ndata: {"text":"Hi "}\n\nevent: del',
        'ta\ndata: {"text":"Maya"}\n\n',
        'event: done\ndata: {"id":"od_1","text":"Hi Maya"}\n\n',
      ])) as typeof fetch;
    try {
      const pieces: string[] = [];
      const draft = await streamOtto('/api/v1/otto/digest/stream', {}, (d) => pieces.push(d));
      expect(pieces).toEqual(['Hi ', 'Maya']);
      expect(draft).toMatchObject({ id: 'od_1', text: 'Hi Maya' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('throws the JSON error before a stream, and an error event during one', async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json(
          { data: null, error: { code: 'otto_not_connected', message: 'Connect first.' } },
          { status: 409 },
        )) as typeof fetch;
      const before = await streamOtto('/api/v1/otto/digest/stream', {}, () => {}).catch((e) => e);
      expect(before).toBeInstanceOf(ApiError);
      expect(before).toMatchObject({ status: 409, code: 'otto_not_connected' });

      globalThis.fetch = (async () =>
        streamOf([
          'event: error\ndata: {"code":"ai_unavailable","message":"No"}\n\n',
        ])) as typeof fetch;
      const during = await streamOtto('/api/v1/otto/digest/stream', {}, () => {}).catch((e) => e);
      expect(during).toMatchObject({ status: 503, code: 'ai_unavailable' });
    } finally {
      globalThis.fetch = original;
    }
  });
});

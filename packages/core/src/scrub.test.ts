import { describe, expect, it } from 'vitest';
import { ALLOWED_HEADERS, scrubEvent, scrubText } from './scrub';

describe('scrubText', () => {
  it('stays linear on long input', () => {
    for (const input of [
      'a'.repeat(100_000),
      `${'a'.repeat(50_000)}@`,
      `+${' '.repeat(50_000)}`,
      'a@'.repeat(50_000),
      `${'a.'.repeat(50_000)}@x`,
      `${'a'.repeat(50_000)}@${'b-'.repeat(20_000)}`,
    ]) {
      const start = performance.now();
      const out = scrubText(input);
      expect(performance.now() - start).toBeLessThan(200);
      expect(typeof out).toBe('string');
    }
  });

  it('replaces emails', () => {
    expect(scrubText('mail ada@example.test now')).toBe('mail [email] now');
  });

  it('replaces the whole local part, however long', () => {
    expect(scrubText(`${'a'.repeat(70)}@example.test`)).toBe('[email]');
    expect(scrubText(`mail ${'a'.repeat(300)}@example.test now`)).toBe('mail [email] now');
    expect(scrubText(`<${'first.last+tag'.repeat(8)}@example.test>`)).toBe('<[email]>');
  });

  it('replaces phone numbers in the supported shapes', () => {
    expect(scrubText('call +1 202 555 0101')).toBe('call [phone]');
    expect(scrubText('id 2025550101')).toBe('id [phone]');
    expect(scrubText('(202) 555-0101')).toBe('[phone]');
    expect(scrubText('202-555-0101')).toBe('[phone]');
    expect(scrubText('202.555.0101')).toBe('[phone]');
    expect(scrubText('202 555 0101')).toBe('[phone]');
  });

  it('leaves ISO dates and times alone', () => {
    expect(scrubText('on 2026-11-12 at 10:42:07')).toBe('on 2026-11-12 at 10:42:07');
    expect(scrubText('2026-11-12T10:42:07.123Z')).toBe('2026-11-12T10:42:07.123Z');
  });

  it('redacts bearer tokens', () => {
    expect(scrubText('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
  });

  it('drops the params tail', () => {
    const out = scrubText('Failed query: insert …\nparams: +12025550123,tok');
    expect(out).not.toContain('2025550123');
    expect(out).not.toContain('tok');
    expect(out.endsWith('params: [redacted]')).toBe(true);
  });
});

function fullEvent() {
  return {
    message: 'hello ada@example.test',
    exception: { values: [{ value: 'bad +1 202 555 0101', type: 'Error' }] },
    request: {
      url: 'https://app.example.test/contacts?email=ada@example.test',
      method: 'POST',
      data: { name: 'Ada' },
      cookies: { session: 'abc' },
      query_string: 'email=ada@example.test',
      headers: {
        'User-Agent': 'agent/1',
        'Content-Type': 'application/json',
        Authorization: 'Bearer abc',
        Cookie: 'session=abc',
      },
    },
    user: { id: 'u_1', email: 'ada@example.test', ip_address: '1.2.3.4' },
    breadcrumbs: [
      {
        message: 'fetch 2025550101',
        data: { url: 'https://api.example.test/x?phone=2025550101', status: 200 },
      },
    ],
    extra: {
      a: { b: { note: 'ada@example.test' } },
      list: ['ada@example.test', { n: '2025550101' }],
    },
    contexts: { ctx: { who: 'ada@example.test' } },
    tags: { who: 'ada@example.test' },
  };
}

describe('scrubEvent', () => {
  it('applies the PII rules to a full event', () => {
    const out = scrubEvent(fullEvent());
    expect(out.message).toBe('hello [email]');
    expect(out.exception?.values?.[0]?.value).toBe('bad [phone]');
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.url).toBe('https://app.example.test/contacts');
    expect(
      Object.keys(out.request?.headers ?? {})
        .map((k) => k.toLowerCase())
        .sort(),
    ).toEqual([...ALLOWED_HEADERS].sort());
    expect(out.user).toEqual({ id: 'u_1' });
    expect(out.breadcrumbs?.[0]?.message).toBe('fetch [phone]');
    expect(out.breadcrumbs?.[0]?.data?.url).toBe('https://api.example.test/x');
    expect(out.breadcrumbs?.[0]?.data?.status).toBe(200);
  });

  it('scrubs nested strings in extra, contexts and tags, arrays included', () => {
    const out = scrubEvent(fullEvent());
    expect(JSON.stringify(out.extra)).not.toContain('example.test');
    expect(JSON.stringify(out.extra)).not.toContain('2025550101');
    expect(out.contexts).toEqual({ ctx: { who: '[email]' } });
    expect(out.tags).toEqual({ who: '[email]' });
  });

  it('truncates values deeper than 6 levels', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: 'x' } } } } } } };
    const out = scrubEvent({ extra: deep });
    expect(JSON.stringify(out.extra)).toContain('[truncated]');
    expect(JSON.stringify(out.extra)).not.toContain('"x"');
  });

  it('passes sdkProcessingMetadata through by reference, sampling values intact', () => {
    const sdkProcessingMetadata = {
      dynamicSamplingContext: {
        trace_id: '1234567890abcdef1234567890abcdef',
        sample_rand: '0.8374651928374',
      },
    };
    const out = scrubEvent({ message: 'x', sdkProcessingMetadata });
    expect(out.sdkProcessingMetadata).toBe(sdkProcessingMetadata);
    expect(sdkProcessingMetadata.dynamicSamplingContext.sample_rand).toBe('0.8374651928374');
  });

  it('keeps Sentry ids and sampling values at any depth, and still scrubs their neighbours', () => {
    const out = scrubEvent({
      event_id: '12345678901234567890123456789012',
      contexts: {
        trace: {
          trace_id: '1234567890abcdef1234567890abcdef',
          span_id: '1234567890123456',
          parent_span_id: '6543210987654321',
        },
        app: { note: 'ask ada@example.test' },
      },
      spans: [
        {
          span_id: '1111111111111111',
          segment_id: '2222222222222222',
          description: 'call +12025550123',
          data: { sample_rate: '0.0500000001', sample_rand: '0.8374651928374' },
        },
      ],
    } as Parameters<typeof scrubEvent>[0] & { event_id: string; spans: unknown[] });
    expect(out.event_id).toBe('12345678901234567890123456789012');
    expect(out.contexts).toEqual({
      trace: {
        trace_id: '1234567890abcdef1234567890abcdef',
        span_id: '1234567890123456',
        parent_span_id: '6543210987654321',
      },
      app: { note: 'ask [email]' },
    });
    expect(out.spans).toEqual([
      {
        span_id: '1111111111111111',
        segment_id: '2222222222222222',
        description: 'call [phone]',
        data: { sample_rate: '0.0500000001', sample_rand: '0.8374651928374' },
      },
    ]);
  });

  it('still scrubs a non-string value under a protected key', () => {
    const out = scrubEvent({ extra: { trace_id: { note: 'ada@example.test' } } });
    expect(out.extra).toEqual({ trace_id: { note: '[email]' } });
  });

  it('does not mutate its input', () => {
    const input = fullEvent();
    const snapshot = structuredClone(input);
    scrubEvent(input);
    expect(input).toEqual(snapshot);
  });
});

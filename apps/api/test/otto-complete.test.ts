import type { AiProvider, AiRequest, AiResult } from '@knoqra/providers';
import { AiProviderError, NO_PRIVATE_ENDPOINT } from '@knoqra/providers';
import { describe, expect, it } from 'vitest';
import type { OttoAccess } from '../src/otto/access';
import { completeWithCitations, failureOf } from '../src/otto/complete';
import { BUSY_EARLY_ACCESS_MESSAGE, BUSY_MESSAGE, userFailure } from '../src/routes/otto';

const req: AiRequest = {
  purpose: 'brief',
  prompt: 'Contact: Maya',
  sources: [
    { kind: 'timeline', ref: 'te_a', text: 'a' },
    { kind: 'task', ref: 'tk_b', text: 'b' },
  ],
};
const usage = { inputTokens: 1, outputTokens: 1 };
const fixed = (r: AiResult): AiProvider => ({ complete: async () => r });

describe('completeWithCitations', () => {
  it('keeps only real refs, once each, in source order', async () => {
    const result = await completeWithCitations(
      fixed({ text: 'x', citations: ['te_fake', 'tk_b', 'te_a', 'tk_b'], usage }),
      req,
    );
    expect(result).toEqual({
      ok: true,
      value: { text: 'x', citations: ['te_a', 'tk_b'], usage },
    });
  });

  it('turns a throwing provider into ai_unavailable', async () => {
    const result = await completeWithCitations(
      {
        complete: async () => {
          throw new Error('boom');
        },
      },
      req,
    );
    expect(result).toEqual({ ok: false, error: 'ai_unavailable' });
  });

  it.each([
    ['empty text', { text: '', citations: [], usage }],
    ['non-array citations', { text: 'x', citations: 'te_a', usage }],
    ['negative tokens', { text: 'x', citations: [], usage: { inputTokens: -1, outputTokens: 1 } }],
    [
      'fractional tokens',
      { text: 'x', citations: [], usage: { inputTokens: 1.5, outputTokens: 1 } },
    ],
    ['missing usage', { text: 'x', citations: [] }],
  ])('maps an invalid result (%s) to ai_unavailable', async (_name, bad) => {
    const result = await completeWithCitations(fixed(bad as unknown as AiResult), req);
    expect(result).toEqual({ ok: false, error: 'ai_unavailable' });
  });
});

describe('failed model calls', () => {
  it('sorts rate limits, overload and timeouts as busy', () => {
    for (const status of [408, 429, 502, 503, 504, 529]) {
      expect(failureOf(new AiProviderError(status))).toBe('ai_busy');
    }
    expect(failureOf(new AiProviderError(0, 'overloaded'))).toBe('ai_busy');
    expect(failureOf(new DOMException('slow', 'TimeoutError'))).toBe('ai_busy');
    expect(failureOf(new AiProviderError(404, NO_PRIVATE_ENDPOINT))).toBe('ai_no_private_endpoint');
    expect(failureOf(new AiProviderError(401))).toBe('ai_unavailable');
    expect(failureOf(new Error('no text'))).toBe('ai_unavailable');
  });

  it('says busy, not broken, on a shared model, and early access when it is', async () => {
    const included = (earlyAccess: boolean): Extract<OttoAccess, { ready: true }> => ({
      ready: true,
      mode: 'included',
      providerName: 'platform',
      connection: {
        kind: 'api_key',
        apiKey: 'k',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'inclusionai/ling-3.2-flash:free',
      },
      dailyLimit: 100,
      plan: 'Pro',
      earlyAccess,
    });
    expect(userFailure(included(true), 'ai_busy')).toEqual({
      code: 'ai_busy',
      message: BUSY_EARLY_ACCESS_MESSAGE,
    });
    expect(BUSY_EARLY_ACCESS_MESSAGE).toBe(
      'Otto is busy right now (early access). Try again in a minute.',
    );
    expect(userFailure(included(false), 'ai_busy')).toEqual({
      code: 'ai_busy',
      message: BUSY_MESSAGE,
    });
    // A workspace's own key: a 429 may be an empty OpenAI account, so it is not "busy".
    expect(userFailure({ ...included(false), mode: 'own_key' }, 'ai_busy').code).toBe(
      'ai_unavailable',
    );
    expect(userFailure(included(true), 'ai_no_private_endpoint').code).toBe('ai_unavailable');
  });

  it('streams a busy failure from the provider as a result, not a throw', async () => {
    const result = await completeWithCitations(
      {
        complete: async () => {
          throw new AiProviderError(429);
        },
      },
      req,
    );
    expect(result).toEqual({ ok: false, error: 'ai_busy' });
  });
});

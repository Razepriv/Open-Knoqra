import type { AiProvider, AiRequest, AiResult } from '@knoqra/providers';
import { describe, expect, it } from 'vitest';
import { completeWithCitations } from '../src/otto/complete';

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

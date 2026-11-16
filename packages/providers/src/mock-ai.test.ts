import { describe, expect, it } from 'vitest';
import { MockAiProvider } from './mock-ai';

const source = (n: number, text = `fact ${n}`) => ({ kind: 'timeline', ref: `te_${n}`, text });

describe('MockAiProvider', () => {
  it('is deterministic: the same input gives the same output', async () => {
    const req = {
      purpose: 'brief' as const,
      prompt: 'Contact: Maya Okafor',
      sources: [source(1), source(2)],
    };
    const mock = new MockAiProvider();
    expect(await mock.complete(req)).toEqual(await mock.complete(req));
  });

  it('opens each purpose with its own line', async () => {
    const mock = new MockAiProvider();
    const draft = await mock.complete({
      purpose: 'draft',
      prompt: 'Contact: Maya Okafor\nChannel: sms',
      sources: [],
    });
    expect(draft.text).toBe('Hi Maya, following up on our last conversation.');
    const brief = await mock.complete({ purpose: 'brief', prompt: 'Contact: Maya', sources: [] });
    expect(brief.text).toBe("Here's the short version.");
    const digest = await mock.complete({ purpose: 'digest', prompt: 'x', sources: [] });
    expect(digest.text).toBe("Here's what happened while you were away.");
  });

  it('lists at most 5 sources as bullets and cites exactly those', async () => {
    const r = await new MockAiProvider().complete({
      purpose: 'brief',
      prompt: 'Contact: Maya',
      sources: [1, 2, 3, 4, 5, 6, 7].map((n) => source(n)),
    });
    const lines = r.text.split('\n');
    expect(lines.filter((l) => l.startsWith('• '))).toHaveLength(5);
    expect(r.citations).toEqual(['te_1', 'te_2', 'te_3', 'te_4', 'te_5']);
  });

  it('cuts each bullet to 140 characters and counts tokens as ceil(chars/4)', async () => {
    const prompt = 'Contact: Maya';
    const r = await new MockAiProvider().complete({
      purpose: 'brief',
      prompt,
      sources: [source(1, 'x'.repeat(300))],
    });
    expect(r.text.split('\n')[1]).toBe(`• ${'x'.repeat(140)}`);
    expect(r.usage).toEqual({
      inputTokens: Math.ceil(prompt.length / 4),
      outputTokens: Math.ceil(r.text.length / 4),
    });
  });
});

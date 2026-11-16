import { describe, expect, it } from 'vitest';
import { aiProviderForConnection, chatMessages, OpenAiCompatibleProvider } from './ai-connection';
import { MockAiProvider } from './mock-ai';

const req = {
  purpose: 'brief' as const,
  prompt: 'Contact: Ada',
  sources: [
    { kind: 'note', ref: 'te_1', text: 'Asked for pricing' },
    { kind: 'call', ref: 'cl_2', text: 'Called for 3 minutes' },
  ],
};

describe('AI connections', () => {
  it('uses the mock for a mock connection', () => {
    expect(aiProviderForConnection({ kind: 'mock' })).toBeInstanceOf(MockAiProvider);
  });

  it('numbers the sources and states the purpose', () => {
    const [system, user] = chatMessages(req);
    expect(system?.content).toContain('short brief');
    expect(user?.content).toContain('1. [te_1] (note) Asked for pricing');
  });

  it('calls a Chat Completions API with the key and keeps only cited refs', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        choices: [{ message: { content: 'Ada asked for pricing [te_1].' } }],
        usage: { prompt_tokens: 40, completion_tokens: 9 },
      });
    }) as unknown as typeof fetch;
    const provider = aiProviderForConnection(
      { kind: 'api_key', apiKey: 'test-key', baseUrl: 'https://ai.example.test/v1/', model: 'm' },
      { fetch: fakeFetch },
    );
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    const result = await provider.complete(req);
    expect(calls[0]?.url).toBe('https://ai.example.test/v1/chat/completions');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer test-key');
    expect(result).toEqual({
      text: 'Ada asked for pricing [te_1].',
      citations: ['te_1'],
      usage: { inputTokens: 40, outputTokens: 9 },
    });
  });

  it('throws on an error answer or an empty one', async () => {
    const answer = (res: Response) =>
      new OpenAiCompatibleProvider({
        baseUrl: 'https://ai.example.test/v1',
        model: 'm',
        token: 't',
        fetch: (async () => res) as unknown as typeof fetch,
      });
    await expect(answer(new Response('no', { status: 401 })).complete(req)).rejects.toThrow('401');
    await expect(answer(Response.json({ choices: [] })).complete(req)).rejects.toThrow('no text');
  });
});

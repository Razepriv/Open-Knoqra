import { describe, expect, it } from 'vitest';
import {
  AiProviderError,
  aiProviderForConnection,
  chatMessages,
  checkAiApiKey,
  isOpenRouter,
  NO_PRIVATE_ENDPOINT,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
  sseData,
} from './ai-connection';
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

  it('sends tuning to a Chat Completions server only when set', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const base = { kind: 'api_key' as const, apiKey: 'k', baseUrl: 'https://ai.example.test/v1' };
    await aiProviderForConnection(
      { ...base, model: 'm', tuning: { maxOutputTokens: 900, reasoningEffort: 'low' } },
      { fetch: fakeFetch },
    ).complete(req);
    await aiProviderForConnection({ ...base, model: 'm' }, { fetch: fakeFetch }).complete(req);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 900, reasoning_effort: 'low' });
    expect(bodies[1]).not.toHaveProperty('max_completion_tokens');
    expect(bodies[1]).not.toHaveProperty('store');
  });
});

const sse = (events: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const raw = events.map((e) => `data: ${e}\n\n`).join('');
        // Split mid-line to prove the parser buffers across chunks.
        const encoded = new TextEncoder().encode(raw);
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

describe('streaming', () => {
  it('reads data lines across chunk boundaries', async () => {
    const stream = sse(['one', 'two']).body;
    if (!stream) throw new Error('no body');
    const seen: string[] = [];
    for await (const data of sseData(stream)) seen.push(data);
    expect(seen).toEqual(['one', 'two']);
  });

  it('hands over each delta, then the trimmed text, citations and usage', async () => {
    const chunk = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
    let sent: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sse([
        chunk('\n Ada'),
        chunk(' asked for pricing'),
        chunk(' [te_1].'),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 7 } }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const provider = aiProviderForConnection(
      { kind: 'api_key', apiKey: 'k', baseUrl: 'https://ai.example.test/v1', model: 'm' },
      { fetch: fakeFetch },
    );
    const deltas: string[] = [];
    const result = await provider.stream?.(req, (d) => deltas.push(d));
    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(deltas).toEqual(['Ada', ' asked for pricing', ' [te_1].']);
    expect(result).toEqual({
      text: 'Ada asked for pricing [te_1].',
      citations: ['te_1'],
      usage: { inputTokens: 30, outputTokens: 7 },
    });
  });

  it('streams the mock a word at a time with the same result as complete', async () => {
    const mock = new MockAiProvider();
    const deltas: string[] = [];
    const streamed = await mock.stream(req, (d) => deltas.push(d));
    expect(deltas.join('')).toBe(streamed.text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(streamed).toEqual(await mock.complete(req));
  });
});

describe('Responses API', () => {
  const delta = (d: string) => JSON.stringify({ type: 'response.output_text.delta', delta: d });
  const completed = JSON.stringify({
    type: 'response.completed',
    response: { usage: { input_tokens: 21, output_tokens: 5 } },
  });
  const recording = (events: string[]) => {
    const sent: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return sse(events);
    }) as unknown as typeof fetch;
    return { sent, fakeFetch };
  };

  it('serves an OpenAI key: streamed, not stored, tuned, with usage', async () => {
    const { sent, fakeFetch } = recording([
      delta(' Ada'),
      delta(' wants pricing [te_1].'),
      completed,
    ]);
    const provider = aiProviderForConnection(
      {
        kind: 'api_key',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'gpt-6-luna',
        tuning: { maxOutputTokens: 800, reasoningEffort: 'low' },
      },
      { fetch: fakeFetch },
    );
    expect(provider).toBeInstanceOf(OpenAiResponsesProvider);
    const deltas: string[] = [];
    const result = await provider.stream?.(req, (d) => deltas.push(d));
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]?.auth).toBe('Bearer sk-test');
    expect(sent[0]?.body).toMatchObject({
      model: 'gpt-6-luna',
      store: false,
      stream: true,
      max_output_tokens: 800,
      reasoning: { effort: 'low' },
    });
    expect(String(sent[0]?.body.instructions)).toContain('You are Otto');
    expect(deltas).toEqual(['Ada', ' wants pricing [te_1].']);
    expect(result).toEqual({
      text: 'Ada wants pricing [te_1].',
      citations: ['te_1'],
      usage: { inputTokens: 21, outputTokens: 5 },
    });
    // complete() reads the same stream.
    expect(await provider.complete(req)).toEqual(result);
  });

  it('sends a ChatGPT sign-in no tuning fields', async () => {
    const { sent, fakeFetch } = recording([delta('Hi'), completed]);
    await aiProviderForConnection(
      { kind: 'chatgpt', accessToken: 'at', model: 'gpt-6.1-sol' },
      { fetch: fakeFetch },
    ).complete(req);
    expect(sent[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]?.auth).toBe('Bearer at');
    expect(sent[0]?.body).not.toHaveProperty('max_output_tokens');
    expect(sent[0]?.body).not.toHaveProperty('reasoning');
    expect(sent[0]?.body).toMatchObject({ store: false, stream: true });
  });

  it('fails on a mid-stream error, an unfinished stream or an error status', async () => {
    const failed = JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    });
    const connection = { kind: 'chatgpt' as const, accessToken: 'at', model: 'm' };
    const run = (events: string[]) =>
      aiProviderForConnection(connection, { fetch: recording(events).fakeFetch }).complete(req);
    await expect(run([delta('Hi'), failed])).rejects.toThrow(
      'subscription_sharing_usage_limit_exceeded',
    );
    await expect(run([delta('Hi')])).rejects.toThrow('before the answer was complete');
    const refusing = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(
      aiProviderForConnection(connection, { fetch: refusing }).complete(req),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('checkAiApiKey', () => {
  const answering = (status: number) =>
    (async () => new Response('{}', { status })) as unknown as typeof fetch;

  it('lists models with the key and reads the status', async () => {
    let auth = '';
    let url = '';
    const fakeFetch = (async (u: string, init: RequestInit) => {
      url = u;
      auth = new Headers(init.headers).get('authorization') ?? '';
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    expect(await checkAiApiKey('sk-test', { fetch: fakeFetch })).toBe('valid');
    expect(url).toBe('https://api.openai.com/v1/models');
    expect(auth).toBe('Bearer sk-test');
    expect(await checkAiApiKey('k', { fetch: answering(401) })).toBe('invalid');
    expect(await checkAiApiKey('k', { fetch: answering(403) })).toBe('invalid');
    expect(await checkAiApiKey('k', { fetch: answering(500) })).toBe('unreachable');
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkAiApiKey('k', { fetch: failing })).toBe('unreachable');
  });
});

describe('OpenRouter', () => {
  const OPENROUTER = 'https://openrouter.ai/api/v1';
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const answering = (res: () => Response) =>
    (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      return res();
    }) as unknown as typeof fetch;
  const connect = (fetchImpl: typeof fetch, model = 'inclusionai/ling-3.2-flash:free') =>
    aiProviderForConnection(
      {
        kind: 'api_key',
        apiKey: 'sk-or-test',
        baseUrl: OPENROUTER,
        model,
        tuning: { maxOutputTokens: 1200, reasoningEffort: 'low' },
      },
      { fetch: fetchImpl },
    );

  it('recognizes its host only', () => {
    expect(isOpenRouter(OPENROUTER)).toBe(true);
    expect(isOpenRouter('https://eu.openrouter.ai/api/v1')).toBe(true);
    expect(isOpenRouter('https://openrouter.ai.example.test/v1')).toBe(false);
    expect(isOpenRouter('https://api.openai.com/v1')).toBe(false);
    expect(isOpenRouter('not a url')).toBe(false);
  });

  it('sends attribution, the privacy filters, the fallback and its own tuning fields', async () => {
    sent.length = 0;
    const provider = connect(
      answering(() => Response.json({ choices: [{ message: { content: 'Hi [te_1]' } }] })),
      'inclusionai/ling-3.2-flash:free, openrouter/free',
    );
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    await provider.complete(req);
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0]?.headers.get('http-referer')).toBe('https://knoqra.app');
    expect(sent[0]?.headers.get('x-title')).toBe('KNOQRA');
    expect(sent[0]?.headers.get('authorization')).toBe('Bearer sk-or-test');
    expect(sent[0]?.body).toMatchObject({
      model: 'inclusionai/ling-3.2-flash:free',
      models: ['inclusionai/ling-3.2-flash:free', 'openrouter/free'],
      provider: { data_collection: 'deny', zdr: true },
      max_tokens: 1200,
      reasoning: { effort: 'low', exclude: true },
    });
    expect(sent[0]?.body).not.toHaveProperty('max_completion_tokens');
    expect(sent[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends none of that to another server', async () => {
    sent.length = 0;
    await aiProviderForConnection(
      { kind: 'api_key', apiKey: 'k', baseUrl: 'https://ai.example.test/v1', model: 'a, b' },
      { fetch: answering(() => Response.json({ choices: [{ message: { content: 'ok' } }] })) },
    ).complete(req);
    expect(sent[0]?.headers.get('http-referer')).toBeNull();
    expect(sent[0]?.body.model).toBe('a');
    expect(sent[0]?.body).not.toHaveProperty('provider');
    expect(sent[0]?.body).not.toHaveProperty('models');
  });

  it('names a missing private endpoint, and keeps 429 as a status', async () => {
    const failing = (status: number) =>
      connect(answering(() => Response.json({ error: { code: status } }, { status }))).complete(
        req,
      );
    const noEndpoint = await failing(404).catch((e: unknown) => e);
    expect(noEndpoint).toBeInstanceOf(AiProviderError);
    expect(noEndpoint).toMatchObject({ status: 404, code: NO_PRIVATE_ENDPOINT });
    expect(await failing(429).catch((e: unknown) => e)).toMatchObject({ status: 429, code: null });
  });

  it('turns an error inside the stream or a 200 answer into an AiProviderError', async () => {
    const midStream = connect(
      answering(() =>
        sse([
          JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
          JSON.stringify({ error: { code: 429, message: 'Rate limit' }, choices: [] }),
        ]),
      ),
    );
    await expect(midStream.stream?.(req, () => {})).rejects.toMatchObject({
      status: 429,
      code: '429',
    });
    const inline = connect(
      answering(() => Response.json({ error: { code: 'overloaded', message: 'busy' } })),
    );
    await expect(inline.complete(req)).rejects.toMatchObject({ status: 0, code: 'overloaded' });
  });
});

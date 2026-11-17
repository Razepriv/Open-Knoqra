import { MockAiProvider } from './mock-ai';
import type { AiProvider, AiRequest, AiResult } from './types';

/**
 * Optional limits on one model call. The platform key sets them to keep included use affordable;
 * a workspace's own key leaves them unset.
 */
export interface AiTuning {
  /** Caps the answer, reasoning included. */
  maxOutputTokens?: number;
  /** How hard a reasoning model thinks before it answers, for example `low`. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

/**
 * How Otto reaches a model. Every edition shares the same recommendation and personalization
 * layer (sources, prompts, limits, citations); only this connection differs.
 *
 * - `mock`: no model, deterministic drafts (development, tests and demos).
 * - `api_key`: an OpenAI-compatible Chat Completions API with an API key: a workspace's own
 *   OpenAI key, the instance's `AI_API_KEY`, or KNOQRA Cloud's platform key.
 * - `chatgpt`: a user's own ChatGPT account through "Sign in with ChatGPT" (OAuth). Behind a
 *   feature flag: OpenAI does not offer this sign-in to other apps today.
 */
export type AiConnection =
  | { kind: 'mock' }
  | {
      kind: 'api_key';
      apiKey: string;
      baseUrl: string;
      model: string;
      tuning?: AiTuning;
    }
  | { kind: 'chatgpt'; accessToken: string; model: string; baseUrl?: string };

/** OpenAI's API, the default for an `api_key` connection without a base URL. */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
/**
 * The model a connection uses when none is named: OpenAI's most efficient model as of 2026-11
 * ($0.10 in, $0.50 out per million tokens). Override it with the connection.
 */
export const DEFAULT_AI_MODEL = 'gpt-6-luna';

const PURPOSES: Record<AiRequest['purpose'], string> = {
  draft: 'Draft a short, friendly follow-up message to the contact.',
  brief: 'Write a short brief about the contact: who they are and where things stand.',
  digest: 'Summarize what happened while the user was away, most important first.',
};

const SYSTEM = [
  'You are Otto, the assistant inside KNOQRA, a communications workspace.',
  'Use only the numbered sources given. Do not invent facts, numbers or promises.',
  'Cite each source you rely on by writing its ref in square brackets, for example [ct_123].',
  'Your text is shown to the user as a draft to review; it is never sent on its own.',
].join(' ');

/** The prompt sent to a Chat Completions model for `req`. */
export function chatMessages(req: AiRequest): { role: 'system' | 'user'; content: string }[] {
  const sources = req.sources.map((s, i) => `${i + 1}. [${s.ref}] (${s.kind}) ${s.text}`);
  return [
    { role: 'system', content: `${SYSTEM} ${PURPOSES[req.purpose]}` },
    { role: 'user', content: `${req.prompt}\n\nSources:\n${sources.join('\n') || '(none)'}` },
  ];
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
/** An error a server reports inside a 200 answer or a stream chunk (OpenRouter does both). */
interface InlineError {
  code?: number | string | null;
}
interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: ChatUsage | null;
  error?: InlineError | null;
}
interface ChatChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: ChatUsage | null;
  error?: InlineError | null;
}

const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, '');
const isOpenAi = (baseUrl: string) => trimBase(baseUrl) === DEFAULT_AI_BASE_URL;

/** True when `baseUrl` is OpenRouter's API, which takes routing and privacy fields. */
export function isOpenRouter(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

/** Who calls OpenRouter, sent as its app attribution headers. */
export const OPENROUTER_REFERER = 'https://knoqra.app';
export const OPENROUTER_TITLE = 'KNOQRA';
/**
 * Every OpenRouter request routes only to endpoints that neither train on nor keep prompts:
 * `data_collection: deny` leaves out providers that store or train on data, and `zdr` (zero data
 * retention) leaves out providers that keep prompts for a while. Contacts, messages and
 * transcripts must never reach any other endpoint.
 */
export const OPENROUTER_PRIVACY = { data_collection: 'deny', zdr: true } as const;
/**
 * OpenRouter's answer when no endpoint of the model passes the privacy filters (404, "No endpoints
 * found matching your data policy"). Pick another model.
 */
export const NO_PRIVATE_ENDPOINT = 'no_endpoint_for_data_policy';

/** `a, b` is the model `a` with `b` as a fallback (OpenRouter's `models`); elsewhere just `a`. */
export function modelList(model: string): string[] {
  return model
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/** The error a server reported inline, as an AiProviderError. */
function inlineError(error: InlineError): AiProviderError {
  const status = typeof error.code === 'number' ? error.code : Number(error.code) || 0;
  return new AiProviderError(status, error.code == null ? 'stream_error' : String(error.code));
}

/**
 * A model answered with an error status, or failed mid-stream with an error code. Carries those
 * only, never a body: an answer may echo the prompt.
 */
export class AiProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(code ? `AI provider failed: ${code}` : `AI provider answered ${status}`);
    this.name = 'AiProviderError';
  }
}

/** Only refs the model actually wrote count as citations; Otto keeps the ones that are sources. */
function resultOf(req: AiRequest, raw: string, usage: ChatUsage | null | undefined): AiResult {
  const text = raw.trim();
  if (text === '') throw new Error('AI provider returned no text');
  return {
    text,
    citations: req.sources.map((s) => s.ref).filter((ref) => text.includes(`[${ref}]`)),
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  };
}

/** Yields the `data:` payloads of a server-sent event stream, one per event. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length > 0) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
        newline = buffer.indexOf('\n');
      }
    }
    if (data.length > 0) yield data.join('\n');
  } finally {
    reader.releaseLock();
  }
}

/**
 * An OpenAI-compatible Chat Completions model, for servers other than OpenAI's: OpenRouter (KNOQRA
 * Cloud's included model) or a self-hosted instance's `AI_BASE_URL`. On OpenRouter every request
 * carries the privacy filters above. Nothing here logs, and errors carry a status or an error code
 * only: prompts, answers and keys never leave this class.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    private readonly opts: {
      baseUrl: string;
      model: string;
      token: string;
      tuning?: AiTuning | undefined;
      fetch?: typeof fetch;
    },
  ) {}

  private body(req: AiRequest, stream: boolean): string {
    const { tuning } = this.opts;
    const [model, ...fallbacks] = modelList(this.opts.model);
    const common = {
      model,
      messages: chatMessages(req),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
    if (isOpenRouter(this.opts.baseUrl)) {
      return JSON.stringify({
        ...common,
        ...(fallbacks.length > 0 ? { models: [model, ...fallbacks] } : {}),
        ...(tuning?.maxOutputTokens ? { max_tokens: tuning.maxOutputTokens } : {}),
        // The reasoning stays on OpenRouter's side: only the answer comes back.
        ...(tuning?.reasoningEffort
          ? { reasoning: { effort: tuning.reasoningEffort, exclude: true } }
          : {}),
        provider: OPENROUTER_PRIVACY,
      });
    }
    return JSON.stringify({
      ...common,
      ...(tuning?.maxOutputTokens ? { max_completion_tokens: tuning.maxOutputTokens } : {}),
      ...(tuning?.reasoningEffort ? { reasoning_effort: tuning.reasoningEffort } : {}),
    });
  }

  private async post(req: AiRequest, stream: boolean): Promise<Response> {
    const doFetch = this.opts.fetch ?? fetch;
    const openRouter = isOpenRouter(this.opts.baseUrl);
    const response = await doFetch(`${trimBase(this.opts.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
        ...(stream ? { accept: 'text/event-stream' } : {}),
        ...(openRouter ? { 'HTTP-Referer': OPENROUTER_REFERER, 'X-Title': OPENROUTER_TITLE } : {}),
      },
      body: this.body(req, stream),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const code = openRouter && response.status === 404 ? NO_PRIVATE_ENDPOINT : null;
      throw new AiProviderError(response.status, code);
    }
    return response;
  }

  async complete(req: AiRequest): Promise<AiResult> {
    const body = (await (await this.post(req, false)).json()) as ChatCompletion;
    if (body.error) throw inlineError(body.error);
    return resultOf(req, body.choices?.[0]?.message?.content ?? '', body.usage);
  }

  async stream(req: AiRequest, onText: (delta: string) => void): Promise<AiResult> {
    const response = await this.post(req, true);
    if (!response.body) throw new Error('AI provider sent no stream');
    let text = '';
    let usage: ChatUsage | null | undefined;
    let leading = true;
    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(data) as ChatChunk;
      } catch {
        continue;
      }
      // OpenRouter reports a failure after the stream has started as a chunk with `error`.
      if (chunk.error) throw inlineError(chunk.error);
      if (chunk.usage) usage = chunk.usage;
      let delta = chunk.choices?.[0]?.delta?.content ?? '';
      // The final text is trimmed, so the streamed text starts where it will.
      if (leading) delta = delta.replace(/^\s+/, '');
      if (delta === '') continue;
      leading = false;
      text += delta;
      onText(delta);
    }
    return resultOf(req, text, usage);
  }
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  code?: string;
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number } | null;
    error?: { code?: string } | null;
  };
}

/**
 * OpenAI's Responses API, always streamed and never stored (`store: false`). It serves OpenAI API
 * keys and ChatGPT sign-ins: plan usage through "Sign in with ChatGPT" must stream, must not be
 * stored and refuses tuning fields, so a ChatGPT connection sends none. Like the class above,
 * nothing here logs and errors carry a status or an error code only.
 */
export class OpenAiResponsesProvider implements AiProvider {
  constructor(
    private readonly opts: {
      baseUrl: string;
      model: string;
      token: string;
      tuning?: AiTuning | undefined;
      fetch?: typeof fetch;
    },
  ) {}

  complete(req: AiRequest): Promise<AiResult> {
    return this.stream(req, () => {});
  }

  async stream(req: AiRequest, onText: (delta: string) => void): Promise<AiResult> {
    const { baseUrl, model, token, tuning } = this.opts;
    const [system, user] = chatMessages(req);
    const doFetch = this.opts.fetch ?? fetch;
    const response = await doFetch(`${trimBase(baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        // OpenAI takes one model: a fallback list is for OpenRouter.
        model: modelList(model)[0] ?? model,
        instructions: system?.content,
        input: [{ role: 'user', content: user?.content ?? '' }],
        store: false,
        stream: true,
        ...(tuning?.maxOutputTokens ? { max_output_tokens: tuning.maxOutputTokens } : {}),
        ...(tuning?.reasoningEffort ? { reasoning: { effort: tuning.reasoningEffort } } : {}),
      }),
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiProviderError(response.status);
    }
    if (!response.body) throw new Error('AI provider sent no stream');
    let text = '';
    let usage: ChatUsage | null = null;
    let finished = false;
    let leading = true;
    for await (const data of sseData(response.body)) {
      let event: ResponsesEvent;
      try {
        event = JSON.parse(data) as ResponsesEvent;
      } catch {
        continue;
      }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        // The final text is trimmed, so the streamed text starts where it will.
        const delta = leading ? event.delta.replace(/^\s+/, '') : event.delta;
        if (delta === '') continue;
        leading = false;
        text += delta;
        onText(delta);
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const u = event.response?.usage;
        usage = { prompt_tokens: u?.input_tokens ?? 0, completion_tokens: u?.output_tokens ?? 0 };
        finished = true;
        break;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        // For example `subscription_sharing_usage_limit_exceeded`, mid-stream.
        throw new AiProviderError(0, event.response?.error?.code ?? event.code ?? 'failed');
      }
    }
    if (!finished) throw new Error('AI stream ended before the answer was complete');
    return resultOf(req, text, usage);
  }
}

/** What an OpenAI API key check found. */
export type AiKeyCheck = 'valid' | 'invalid' | 'unreachable';

/**
 * Checks an API key without spending tokens: lists the models it can use. 401 and 403 mean the key
 * is wrong or revoked; anything else that is not a success means the check could not be made.
 */
export async function checkAiApiKey(
  apiKey: string,
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<AiKeyCheck> {
  const doFetch = opts.fetch ?? fetch;
  try {
    const response = await doFetch(`${trimBase(opts.baseUrl ?? DEFAULT_AI_BASE_URL)}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    await response.body?.cancel();
    if (response.ok) return 'valid';
    if (response.status === 401 || response.status === 403) return 'invalid';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The model provider for a connection. */
export function aiProviderForConnection(
  connection: AiConnection,
  deps: { fetch?: typeof fetch } = {},
): AiProvider {
  const withFetch = deps.fetch ? { fetch: deps.fetch } : {};
  switch (connection.kind) {
    case 'mock':
      return new MockAiProvider();
    case 'api_key': {
      const opts = {
        baseUrl: connection.baseUrl,
        model: connection.model,
        token: connection.apiKey,
        tuning: connection.tuning,
        ...withFetch,
      };
      return isOpenAi(connection.baseUrl)
        ? new OpenAiResponsesProvider(opts)
        : new OpenAiCompatibleProvider(opts);
    }
    case 'chatgpt':
      return new OpenAiResponsesProvider({
        baseUrl: connection.baseUrl ?? DEFAULT_AI_BASE_URL,
        model: connection.model,
        token: connection.accessToken,
        ...withFetch,
      });
  }
}

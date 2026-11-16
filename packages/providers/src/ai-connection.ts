import { MockAiProvider } from './mock-ai';
import type { AiProvider, AiRequest, AiResult } from './types';

/**
 * How Otto reaches a model. Every edition shares the same recommendation and personalization
 * layer (sources, prompts, limits, citations); only this connection differs.
 *
 * - `mock`: no model, deterministic drafts (development, tests, and instances without a key).
 * - `api_key`: an OpenAI-compatible Chat Completions API with an API key.
 * - `chatgpt`: a user's own ChatGPT plan through "Sign in with ChatGPT" (OAuth). Reserved: the
 *   sign-in flow is not built yet, so this connection cannot be made today.
 */
export type AiConnection =
  | { kind: 'mock' }
  | { kind: 'api_key'; apiKey: string; baseUrl: string; model: string }
  | { kind: 'chatgpt'; accessToken: string; model: string };

/** OpenAI's API, the default for an `api_key` connection without a base URL. */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
/** The model an `api_key` connection uses when none is named. Override it with the connection. */
export const DEFAULT_AI_MODEL = 'gpt-5-mini';

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

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** An OpenAI-compatible Chat Completions model, reached with an API key or an OAuth token. */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    private readonly opts: {
      baseUrl: string;
      model: string;
      token: string;
      fetch?: typeof fetch;
    },
  ) {}

  async complete(req: AiRequest): Promise<AiResult> {
    const doFetch = this.opts.fetch ?? fetch;
    const response = await doFetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.opts.model, messages: chatMessages(req) }),
    });
    if (!response.ok) throw new Error(`AI provider answered ${response.status}`);
    const body = (await response.json()) as ChatCompletion;
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (text === '') throw new Error('AI provider returned no text');
    // Only refs the model actually wrote count as citations; Otto keeps the ones that are sources.
    const citations = req.sources.map((s) => s.ref).filter((ref) => text.includes(`[${ref}]`));
    return {
      text,
      citations,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** The model provider for a connection. */
export function aiProviderForConnection(
  connection: AiConnection,
  deps: { fetch?: typeof fetch } = {},
): AiProvider {
  switch (connection.kind) {
    case 'mock':
      return new MockAiProvider();
    case 'api_key':
      return new OpenAiCompatibleProvider({
        baseUrl: connection.baseUrl,
        model: connection.model,
        token: connection.apiKey,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    case 'chatgpt':
      return new OpenAiCompatibleProvider({
        baseUrl: DEFAULT_AI_BASE_URL,
        model: connection.model,
        token: connection.accessToken,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
  }
}

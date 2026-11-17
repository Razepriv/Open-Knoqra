import {
  type AiConnection,
  type AiProvider,
  aiProviderForConnection,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
} from '@knoqra/providers';
import type { Env } from '../env';

type AiEnv = Pick<Env, 'AI_PROVIDER' | 'AI_API_KEY' | 'AI_MODEL' | 'AI_BASE_URL'> &
  Partial<Pick<Env, 'APP_ENV'>>;

/**
 * The instance's own model connection, from `AI_PROVIDER`, for workspaces that have not connected
 * their own (otto/access.ts):
 * - `mock`: the deterministic mock. Unset or blank means the same in development and tests;
 * - `openai`: an OpenAI-compatible API with `AI_API_KEY` (and optional `AI_MODEL`, `AI_BASE_URL`);
 * - `none`, unset elsewhere, or `chatgpt`: none, so each workspace connects its own key in
 *   Settings (or its ChatGPT plan, where that sign-in is on).
 * Anything else, or `openai` without a key, is not configured and throws.
 */
export function aiConnectionFor(env: AiEnv): { name: string; connection: AiConnection } | null {
  const local = env.APP_ENV === 'development' || env.APP_ENV === 'test';
  // An empty or blank value (a cleared secret, `AI_PROVIDER=` in .dev.vars) means unset.
  const name = env.AI_PROVIDER?.trim() || (local ? 'mock' : '');
  if (name === '' || name === 'none' || name === 'chatgpt') return null;
  if (name === 'mock') return { name: 'mock', connection: { kind: 'mock' } };
  if (name === 'openai' && env.AI_API_KEY?.trim()) {
    return {
      name: 'openai',
      connection: {
        kind: 'api_key',
        apiKey: env.AI_API_KEY.trim(),
        baseUrl: env.AI_BASE_URL?.trim() || DEFAULT_AI_BASE_URL,
        model: env.AI_MODEL?.trim() || DEFAULT_AI_MODEL,
      },
    };
  }
  throw new Error(`AI provider ${name} is not configured`);
}

/** The provider for a connection: the only place a model plugs in. */
export function aiProviderFor(
  connection: AiConnection,
  deps: { fetch?: typeof fetch } = {},
): AiProvider {
  return aiProviderForConnection(connection, deps);
}

import {
  type AiConnection,
  type AiProvider,
  aiProviderForConnection,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
} from '@knoqra/providers';
import type { Env } from '../env';

type AiEnv = Pick<Env, 'AI_PROVIDER' | 'AI_API_KEY' | 'AI_MODEL' | 'AI_BASE_URL'>;

/**
 * The instance's model connection, from `AI_PROVIDER`:
 * - unset, blank or `mock`: the deterministic mock;
 * - `openai`: an OpenAI-compatible API with `AI_API_KEY` (and optional `AI_MODEL`, `AI_BASE_URL`);
 * - `chatgpt`: each user's own ChatGPT plan. The sign-in flow is not built yet, so it uses the mock
 *   until then.
 * Anything else, or `openai` without a key, is not configured and throws.
 */
export function aiConnectionFor(env: AiEnv): { name: string; connection: AiConnection } {
  // An empty or blank value (a cleared secret, `AI_PROVIDER=` in .dev.vars) means the mock.
  const name = env.AI_PROVIDER?.trim() || 'mock';
  if (name === 'mock' || name === 'chatgpt') return { name: 'mock', connection: { kind: 'mock' } };
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

/**
 * The only place a model plugs in. Called per request, so a misconfigured `AI_PROVIDER` surfaces
 * as a 500 on the Otto routes (and nowhere else) until it is fixed.
 */
export function aiProviderFor(
  env: AiEnv,
  deps: { fetch?: typeof fetch } = {},
): { name: string; provider: AiProvider } {
  const { name, connection } = aiConnectionFor(env);
  return { name, provider: aiProviderForConnection(connection, deps) };
}

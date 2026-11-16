import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  MockAiProvider,
  OpenAiCompatibleProvider,
} from '@knoqra/providers';
import { describe, expect, it } from 'vitest';
import { aiConnectionFor, aiProviderFor } from '../src/otto/provider';

describe('aiProviderFor', () => {
  it('uses the mock provider when AI_PROVIDER is unset, empty or blank', () => {
    for (const AI_PROVIDER of [undefined, '', '   ', 'mock', ' mock ']) {
      const ai = aiProviderFor(AI_PROVIDER === undefined ? {} : { AI_PROVIDER });
      expect(ai.name).toBe('mock');
      expect(ai.provider).toBeInstanceOf(MockAiProvider);
    }
  });

  it('refuses a provider that is not configured', () => {
    expect(() => aiProviderFor({ AI_PROVIDER: 'openai' })).toThrow(
      'AI provider openai is not configured',
    );
    expect(() => aiProviderFor({ AI_PROVIDER: 'other' })).toThrow(
      'AI provider other is not configured',
    );
  });

  it('connects an OpenAI-compatible API with a key, with defaults for the rest', () => {
    const { name, connection } = aiConnectionFor({ AI_PROVIDER: 'openai', AI_API_KEY: ' k ' });
    expect(name).toBe('openai');
    expect(connection).toEqual({
      kind: 'api_key',
      apiKey: 'k',
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
    });
    expect(aiProviderFor({ AI_PROVIDER: 'openai', AI_API_KEY: 'k' }).provider).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
  });

  it('uses the mock for ChatGPT sign-in until that flow exists', () => {
    expect(aiProviderFor({ AI_PROVIDER: 'chatgpt' }).provider).toBeInstanceOf(MockAiProvider);
  });
});

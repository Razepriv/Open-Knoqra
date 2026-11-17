import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  MockAiProvider,
  OpenAiCompatibleProvider,
  OpenAiResponsesProvider,
} from '@knoqra/providers';
import { describe, expect, it } from 'vitest';
import { aiConnectionFor, aiProviderFor } from '../src/otto/provider';

describe('aiConnectionFor (the instance model)', () => {
  it('uses the mock when AI_PROVIDER is mock, or unset in development and tests', () => {
    for (const AI_PROVIDER of [undefined, '', '   ', 'mock', ' mock ']) {
      const env = AI_PROVIDER === undefined ? {} : { AI_PROVIDER };
      for (const APP_ENV of ['development', 'test'] as const) {
        expect(aiConnectionFor({ ...env, APP_ENV })).toEqual({
          name: 'mock',
          connection: { kind: 'mock' },
        });
      }
    }
    expect(aiConnectionFor({ AI_PROVIDER: 'mock', APP_ENV: 'production' })?.name).toBe('mock');
  });

  it('has no instance model when unset outside development, or set to chatgpt', () => {
    expect(aiConnectionFor({ APP_ENV: 'staging' })).toBeNull();
    expect(aiConnectionFor({ AI_PROVIDER: ' ', APP_ENV: 'production' })).toBeNull();
    expect(aiConnectionFor({ AI_PROVIDER: 'chatgpt', APP_ENV: 'test' })).toBeNull();
  });

  it('refuses a provider that is not configured', () => {
    expect(() => aiConnectionFor({ AI_PROVIDER: 'openai' })).toThrow(
      'AI provider openai is not configured',
    );
    expect(() => aiConnectionFor({ AI_PROVIDER: 'other' })).toThrow(
      'AI provider other is not configured',
    );
  });

  it('connects an OpenAI-compatible API with a key, with defaults for the rest', () => {
    expect(aiConnectionFor({ AI_PROVIDER: 'openai', AI_API_KEY: ' k ' })).toEqual({
      name: 'openai',
      connection: {
        kind: 'api_key',
        apiKey: 'k',
        baseUrl: DEFAULT_AI_BASE_URL,
        model: DEFAULT_AI_MODEL,
      },
    });
  });
});

describe('aiProviderFor', () => {
  it('uses the Responses API for OpenAI and Chat Completions for other servers', () => {
    const key = { kind: 'api_key' as const, apiKey: 'k', model: 'm' };
    expect(aiProviderFor({ ...key, baseUrl: DEFAULT_AI_BASE_URL })).toBeInstanceOf(
      OpenAiResponsesProvider,
    );
    expect(aiProviderFor({ ...key, baseUrl: 'https://ai.example.test/v1' })).toBeInstanceOf(
      OpenAiCompatibleProvider,
    );
    expect(aiProviderFor({ kind: 'mock' })).toBeInstanceOf(MockAiProvider);
  });
});

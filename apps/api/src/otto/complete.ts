import { err, ok, type Result } from '@knoqra/core';
import {
  type AiProvider,
  AiProviderError,
  type AiRequest,
  type AiResult,
  NO_PRIVATE_ENDPOINT,
} from '@knoqra/providers';
import { z } from 'zod';
import { logger } from '../lib/logger';

const tokenCount = z.number().int().nonnegative();
const AiResultSchema = z.object({
  text: z.string().min(1),
  citations: z.array(z.string()),
  usage: z.object({ inputTokens: tokenCount, outputTokens: tokenCount }),
});

/** Why a model call failed, as far as Otto tells the user. */
export type OttoFailure = 'ai_busy' | 'ai_unavailable' | 'ai_no_private_endpoint';

/** Statuses and error codes that mean "too many requests or overloaded: try again soon". */
const BUSY_STATUSES = new Set([408, 429, 502, 503, 504, 529]);
const BUSY_CODES = new Set(['rate_limit_exceeded', 'overloaded', 'server_overloaded', 'timeout']);

/** Sorts a failed call: busy (rate limited, overloaded or timed out), no private endpoint, or other. */
export function failureOf(error: unknown): OttoFailure {
  if (error instanceof AiProviderError) {
    if (error.code === NO_PRIVATE_ENDPOINT) return 'ai_no_private_endpoint';
    if (BUSY_STATUSES.has(error.status) || (error.code && BUSY_CODES.has(error.code))) {
      return 'ai_busy';
    }
    return 'ai_unavailable';
  }
  // Otto's own timeout (AbortSignal.timeout) means the model did not keep up.
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'ai_busy';
  return 'ai_unavailable';
}

/**
 * Calls the provider and treats its output as untrusted: a throw becomes a failure (`failureOf`), and
 * only citations that name one of `req.sources` survive, once each, in source order. With
 * `onText`, a provider that streams hands its text over piece by piece first. A failure is logged
 * with its status or error code only, never the prompt or the answer.
 */
export async function completeWithCitations(
  provider: AiProvider,
  req: AiRequest,
  onText?: (delta: string) => void,
): Promise<Result<AiResult, OttoFailure>> {
  let result: AiResult;
  try {
    const raw =
      onText && provider.stream ? await provider.stream(req, onText) : await provider.complete(req);
    const parsed = AiResultSchema.safeParse(raw);
    if (!parsed.success) return err('ai_unavailable');
    result = parsed.data;
  } catch (error) {
    const failure = failureOf(error);
    logger.warn('otto.provider_failed', {
      failure,
      status: error instanceof AiProviderError ? error.status : null,
      code: error instanceof AiProviderError ? error.code : null,
    });
    return err(failure);
  }
  const cited = new Set(result.citations);
  const seen = new Set<string>();
  const citations: string[] = [];
  for (const source of req.sources) {
    if (cited.has(source.ref) && !seen.has(source.ref)) {
      seen.add(source.ref);
      citations.push(source.ref);
    }
  }
  return ok({ ...result, citations });
}

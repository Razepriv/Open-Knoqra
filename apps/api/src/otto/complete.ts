import { err, ok, type Result } from '@knoqra/core';
import type { AiProvider, AiRequest, AiResult } from '@knoqra/providers';
import { z } from 'zod';

const tokenCount = z.number().int().nonnegative();
const AiResultSchema = z.object({
  text: z.string().min(1),
  citations: z.array(z.string()),
  usage: z.object({ inputTokens: tokenCount, outputTokens: tokenCount }),
});

/**
 * Calls the provider and treats its output as untrusted: a throw becomes `ai_unavailable`, and
 * only citations that name one of `req.sources` survive, once each, in source order.
 */
export async function completeWithCitations(
  provider: AiProvider,
  req: AiRequest,
): Promise<Result<AiResult, 'ai_unavailable'>> {
  let result: AiResult;
  try {
    const parsed = AiResultSchema.safeParse(await provider.complete(req));
    if (!parsed.success) return err('ai_unavailable');
    result = parsed.data;
  } catch {
    return err('ai_unavailable');
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

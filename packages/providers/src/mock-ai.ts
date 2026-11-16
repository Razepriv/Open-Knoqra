import type { AiProvider, AiRequest, AiResult } from './types';

const MAX_BULLETS = 5;
const BULLET_CHARS = 140;

const tokens = (chars: number): number => Math.ceil(chars / 4);

/** First word of the `Contact: <name>` line of the prompt, or a neutral fallback. */
function firstName(prompt: string): string {
  const match = /^Contact:[ \t]*(\S+)/m.exec(prompt);
  return match?.[1] ?? 'there';
}

function opening(req: AiRequest): string {
  switch (req.purpose) {
    case 'draft':
      return `Hi ${firstName(req.prompt)}, following up on our last conversation.`;
    case 'brief':
      return "Here's the short version.";
    case 'digest':
      return "Here's what happened while you were away.";
  }
}

/** Deterministic stand-in for a real model: no network, same input gives the same output. */
export class MockAiProvider implements AiProvider {
  async complete(req: AiRequest): Promise<AiResult> {
    const used = req.sources.slice(0, MAX_BULLETS);
    const text = [opening(req), ...used.map((s) => `• ${s.text.slice(0, BULLET_CHARS)}`)].join(
      '\n',
    );
    return {
      text,
      citations: used.map((s) => s.ref),
      usage: { inputTokens: tokens(req.prompt.length), outputTokens: tokens(text.length) },
    };
  }
}

import { z } from '@hono/zod-openapi';

export const SAFE_TEXT_MESSAGE = 'Text contains invalid characters';

// NUL and the other C0 control characters, except tab, line feed and carriage return.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** False when `value` holds NUL or another C0 control character (tab, LF and CR are allowed). */
export function isSafeText(value: string): boolean {
  return !UNSAFE_TEXT.test(value);
}

export interface SafeTextOptions {
  min?: number;
  max?: number;
  /** Trim surrounding whitespace before the length checks. Default true. */
  trim?: boolean;
}

/**
 * A `z.string()` for any user-supplied free text. Rejects NUL (which Postgres text cannot hold,
 * a 500 otherwise) and other control characters, answering 400 `validation_error`.
 * Every free-text input in the API must use this: contact fields, timeline notes, consent
 * evidence, import rows, preferences.
 */
export function safeText(options: SafeTextOptions = {}) {
  let schema = options.trim === false ? z.string() : z.string().trim();
  if (options.min !== undefined) schema = schema.min(options.min);
  if (options.max !== undefined) schema = schema.max(options.max);
  return schema.refine(isSafeText, SAFE_TEXT_MESSAGE);
}

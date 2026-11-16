import { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const ERROR_CODES = [
  'unauthenticated',
  'no_active_org',
  'forbidden',
  'invalid_phone',
  'emergency_not_supported',
  'duplicate_contact',
  'not_found',
  'invalid_signature',
  'invalid_payload',
  'validation_error',
  'payload_too_large',
  'internal_error',
  'quota_exceeded',
  'ai_unavailable',
  'send_blocked',
  'send_paused',
  'template_required',
  'duplicate_template',
  'consent_reason_required',
  'not_configured',
  'voice_not_configured',
  'call_blocked',
  'needs_review',
  'call_in_progress',
  'spend_blocked',
  'invalid_state',
  'outcome_exists',
  'number_not_owned',
  'provider_auth',
  'provider_unavailable',
  'number_not_synced',
  'credential_changed',
  'rate_limited',
  'quote_invalid',
  'connector_conflict',
  'rate_unavailable',
  'license_required',
  'license_invalid',
  'invalid_password',
  'sole_owner_with_members',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** `{ data: T, error: null }`, the success shape of every `/api/v1/*` response. */
export function okEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ data, error: z.null() });
}

/** `{ data: null, error: { code, message } }`, the failure shape of every `/api/v1/*` response. */
export const ErrorEnvelope = z
  .object({
    data: z.null(),
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }),
  })
  .openapi('Error');

export function ok<T, S extends ContentfulStatusCode = 200>(c: Context, data: T, status?: S) {
  return c.json({ data, error: null }, (status ?? 200) as S);
}

export function fail<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  code: ErrorCode,
  message: string,
) {
  return c.json({ data: null, error: { code, message } }, status);
}

/** OpenAPI response entry for an error status. */
export function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ErrorEnvelope } } };
}

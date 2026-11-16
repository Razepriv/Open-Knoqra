import { createRoute, z } from '@hono/zod-openapi';
import { CALL_OUTCOMES } from '@knoqra/core';
import { CallContactSchema, CallSchema } from '../lib/call-json';
import { errorResponse, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import { SpendDecisionSchema } from './wallet';

/** Request and response schemas and the OpenAPI route definitions of `/api/v1/calls`. */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 1024;

const DecisionSchema = z.object({
  outcome: z.enum(['allowed', 'needs_review', 'blocked']),
  reason: z.enum([
    'granted',
    'unknown_manual_call',
    'consent_required',
    'ai_voice_requires_consent',
    'revoked',
    'opted_out',
    'do_not_contact',
  ]),
});

export const DialSchema = z
  .object({
    provider: z.enum(['fake', 'telnyx', 'plivo']),
    to: z.string(),
    from: z.string(),
    clientState: z.string(),
  })
  .openapi('CallDial');
export type DialJson = z.infer<typeof DialSchema>;

const CreatedSchema = z
  .object({ call: CallSchema, dial: DialSchema, warnings: z.array(SpendDecisionSchema) })
  .openapi('CreatedCall');
const AnsweredSchema = z.object({ call: CallSchema, dial: DialSchema }).openapi('AnsweredCall');

const PreflightSchema = z
  .object({
    to: z.string().nullable(),
    contact: CallContactSchema.nullable(),
    decision: DecisionSchema.nullable(),
    spend: SpendDecisionSchema,
    reserveMicros: z.number().int(),
    /** The destination's price per minute, as the call would be authorized now. */
    rate: z
      .object({
        country: z.string(),
        countryName: z.string(),
        numberType: z.enum(['landline', 'mobile', 'mobile_or_landline', 'toll_free', 'special']),
        priceMicrosPerMinute: z.number().int(),
      })
      .nullable(),
  })
  .openapi('CallPreflight');

const CallPageSchema = z
  .object({ items: z.array(CallSchema), nextCursor: z.string().nullable() })
  .openapi('CallPage');

const TargetFields = {
  to: safeText({ min: 1, max: 64 }).optional(),
  contactId: safeText({ min: 1, max: 64 }).optional(),
};

const PreflightQuery = z.object(TargetFields);

export const CreateBody = z
  .object({
    ...TargetFields,
    reviewConfirmed: z.boolean().optional(),
    idempotencyKey: safeText({ min: 8, max: 80 }),
  })
  .openapi('CreateCall');

const OutcomeBody = z
  .object({ outcome: z.enum(CALL_OUTCOMES), note: safeText({ max: 1000 }).optional() })
  .openapi('CallOutcome');

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  direction: z.enum(['all', 'outbound', 'inbound']).default('all'),
});

const CallIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const noSession = errorResponse('No valid session');
const notFoundResponse = errorResponse('No such call in the active organization');

export const preflightRoute = createRoute({
  method: 'get',
  path: '/api/v1/calls/preflight',
  tags: ['calls'],
  summary: 'What would happen if this number or contact were dialed now',
  security,
  request: { query: PreflightQuery },
  responses: {
    200: { description: 'Consent and spend decisions', content: json(okEnvelope(PreflightSchema)) },
    400: errorResponse('Invalid query'),
    401: noSession,
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('The number is not a valid phone number'),
  },
});

export const createCallRoute = createRoute({
  method: 'post',
  path: '/api/v1/calls',
  tags: ['calls'],
  summary: 'Authorize an outbound call: consent, spend reserve and the one-call lock',
  security,
  request: { body: { required: true, content: json(CreateBody) } },
  responses: {
    200: { description: 'Replayed idempotency key', content: json(okEnvelope(CreatedSchema)) },
    201: { description: 'Authorized call', content: json(okEnvelope(CreatedSchema)) },
    400: errorResponse('Invalid body, or neither a number nor a contact'),
    401: noSession,
    402: errorResponse('The spend cap or the balance does not allow the call'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse(
      'Consent needs review, another call is active, voice is not set up, or no active organization',
    ),
    422: errorResponse('Consent blocks the call, or the number is invalid'),
    429: errorResponse('Too many requests'),
  },
});

export const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/calls',
  tags: ['calls'],
  summary: 'A page of calls, newest first',
  security,
  request: { query: ListQuery },
  responses: {
    200: { description: 'Call page', content: json(okEnvelope(CallPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: noSession,
    409: errorResponse('No active organization'),
  },
});

export const activeRoute = createRoute({
  method: 'get',
  path: '/api/v1/calls/active',
  tags: ['calls'],
  summary: "The signed-in user's newest call that has not ended",
  security,
  responses: {
    200: {
      description: 'The active call, or null',
      content: json(okEnvelope(CallSchema.nullable())),
    },
    401: noSession,
    409: errorResponse('No active organization'),
  },
});

export const getCallRoute = createRoute({
  method: 'get',
  path: '/api/v1/calls/{id}',
  tags: ['calls'],
  summary: 'One call',
  security,
  request: { params: CallIdParam },
  responses: {
    200: { description: 'Call', content: json(okEnvelope(CallSchema)) },
    401: noSession,
    404: notFoundResponse,
    409: errorResponse('No active organization'),
  },
});

export const cancelRoute = createRoute({
  method: 'post',
  path: '/api/v1/calls/{id}/cancel',
  tags: ['calls'],
  summary: 'Cancel a call that has not connected (mic denied, dial failure)',
  security,
  request: { params: CallIdParam },
  responses: {
    200: { description: 'Canceled call', content: json(okEnvelope(CallSchema)) },
    401: noSession,
    404: notFoundResponse,
    409: errorResponse(
      "The call can no longer be canceled, is a teammate's call, or no active organization",
    ),
  },
});

export const answerRoute = createRoute({
  method: 'post',
  path: '/api/v1/calls/{id}/answer',
  tags: ['calls'],
  summary: 'Answer a ringing inbound call',
  security,
  request: { params: CallIdParam },
  responses: {
    200: { description: 'Answered call', content: json(okEnvelope(AnsweredSchema)) },
    401: noSession,
    402: errorResponse('The spend cap or the balance does not allow the call'),
    404: notFoundResponse,
    409: errorResponse(
      'Not a ringing inbound call, another call is active, or no active organization',
    ),
    429: errorResponse('Too many requests'),
  },
});

export const outcomeRoute = createRoute({
  method: 'post',
  path: '/api/v1/calls/{id}/outcome',
  tags: ['calls'],
  summary: 'Record the outcome of an ended call (once)',
  security,
  request: { params: CallIdParam, body: { required: true, content: json(OutcomeBody) } },
  responses: {
    200: { description: 'Call with its outcome', content: json(okEnvelope(CallSchema)) },
    400: errorResponse('Invalid body'),
    401: noSession,
    404: notFoundResponse,
    409: errorResponse(
      "The call has not ended, already has an outcome, is a teammate's call, or no active organization",
    ),
  },
});

/** Why a message send failed, in terms the send path and the user can act on. */
export interface MessageFailure {
  code:
    | 'opted_out'
    | 'invalid_number'
    | 'provider_auth'
    | 'provider_rejected'
    | 'provider_rate_limited'
    | 'provider_error';
  message: string;
  /**
   * Whether the same send could succeed if tried again. Informational only: nothing acts on it in
   * Phase 1, which never resends automatically (a failed message stays failed; the user sends anew).
   */
  retryable: boolean;
}

/** A Telnyx error code is kept only when it is a short plain token, as in M2's client. */
export const SAFE_TELNYX_CODE = /^[\w.-]{1,40}$/;

export const sanitizeTelnyxCode = (code: string): string =>
  SAFE_TELNYX_CODE.test(code) ? code : 'unknown';

/**
 * 40300, Telnyx "Blocked (STOP)": the recipient replied STOP to this number. It is the only
 * opt-out code in Telnyx's messaging error reference
 * (developers.telnyx.com/docs/messaging/messages/error-codes).
 */
const OPT_OUT_CODES: ReadonlySet<string> = new Set(['40300']);

/**
 * Destination codes from the same reference: 40001 "Not routable",
 * 40012 "Invalid destination number", 40310 "Invalid 'to' address".
 */
const INVALID_NUMBER_CODES: ReadonlySet<string> = new Set(['40001', '40012', '40310']);

const FAILURES = {
  opted_out: {
    code: 'opted_out',
    message: 'The recipient has opted out of messages from this number.',
    retryable: false,
  },
  invalid_number: {
    code: 'invalid_number',
    message: 'The recipient number cannot receive messages.',
    retryable: false,
  },
  provider_auth: {
    code: 'provider_auth',
    message: 'Your phone provider rejected the saved API key.',
    retryable: false,
  },
  provider_rate_limited: {
    code: 'provider_rate_limited',
    message: 'Your phone provider is limiting sends. Try again shortly.',
    retryable: true,
  },
  provider_rejected: {
    code: 'provider_rejected',
    message: 'Your phone provider rejected the message.',
    retryable: false,
  },
  provider_error: {
    code: 'provider_error',
    message: 'Your phone provider could not be reached or did not accept the message.',
    retryable: true,
  },
} as const satisfies Record<MessageFailure['code'], MessageFailure>;

const failure = (code: MessageFailure['code']): MessageFailure => ({ ...FAILURES[code] });

/**
 * Maps an HTTP status and a Telnyx error code to a failure. Status 0 means the
 * request never got a response. The Telnyx code is checked first, so an opt-out
 * or a bad destination is recognised whatever HTTP status carries it.
 */
export function classifyTelnyxError(status: number, telnyxCode: string): MessageFailure {
  if (OPT_OUT_CODES.has(telnyxCode)) return failure('opted_out');
  if (INVALID_NUMBER_CODES.has(telnyxCode)) return failure('invalid_number');
  if (status === 401 || status === 403) return failure('provider_auth');
  if (status === 429) return failure('provider_rate_limited');
  if (status >= 400 && status < 500) return failure('provider_rejected');
  return failure('provider_error');
}

/**
 * A failed Telnyx messaging request. The message carries the HTTP status and the
 * sanitized Telnyx error code only, never the response body, numbers or the key.
 */
export class TelnyxMessagingError extends Error {
  readonly status: number;
  readonly code: string;
  readonly failure: MessageFailure;

  constructor(status: number, code: string, failure?: MessageFailure) {
    const safeCode = sanitizeTelnyxCode(code);
    super(`Telnyx messaging error: status ${status}, code ${safeCode}`);
    this.name = 'TelnyxMessagingError';
    this.status = status;
    this.code = safeCode;
    this.failure = failure ?? classifyTelnyxError(status, safeCode);
  }
}

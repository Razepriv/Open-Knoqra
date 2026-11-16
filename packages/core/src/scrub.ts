/**
 * PII scrubbing for error reports (Sentry `beforeSend` in the Worker and the Desk).
 * Import from `@knoqra/core/scrub`, never the barrel: it pulls no libphonenumber-js, and
 * keeping it out of the barrel keeps the Desk bundle small.
 */

export const ALLOWED_HEADERS = ['user-agent', 'content-type'] as const;

const MAX_DEPTH = 6;
const TRUNCATED = '[truncated]';
/** Input cap: keeps every regex pass bounded so one huge string cannot stall the isolate. */
const MAX_SCRUB_LENGTH = 8192;

const PARAMS = /\bparams:/i;
const BEARER = /\bBearer\s+\S+/gi;
/**
 * The lookbehind anchors a match at the start of the local part, so it can never begin mid-way
 * (the old `{1,64}` bound left the head of a longer local part in the clear). The local part is
 * unbounded so the whole of it is replaced. Still linear: a match can only start where the
 * previous character is not a local-part character, so each run is scanned from one start only.
 */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const INTL_PHONE = /\+[\d\s.\-()]*\d/g;
const GROUPED_PHONE = /(?:\(\d{3}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
const DIGIT_RUN = /\b\d{7,}\b/g;

function digitCount(text: string): number {
  return text.replace(/\D/g, '').length;
}

/** Replaces emails, phone numbers, bearer tokens and Drizzle's `params:` tail with markers. */
export function scrubText(input: string): string {
  const text =
    input.length > MAX_SCRUB_LENGTH ? `${input.slice(0, MAX_SCRUB_LENGTH)}…[truncated]` : input;
  const at = text.search(PARAMS);
  const head = at === -1 ? text : text.slice(0, at);
  const cleaned = head
    .replace(BEARER, 'Bearer [redacted]')
    .replace(EMAIL, '[email]')
    .replace(INTL_PHONE, (m) => (digitCount(m) >= 7 ? '[phone]' : m))
    .replace(GROUPED_PHONE, '[phone]')
    .replace(DIGIT_RUN, '[phone]');
  return at === -1 ? cleaned : `${cleaned}params: [redacted]`.trim();
}

/**
 * Sentry's own ids and sampling values. They are hex or decimal runs that the phone rules would
 * mangle (`sample_rand` `0.8374651928374` → `0.[phone]`), breaking trace headers. String values
 * under these keys are kept at any depth; they carry no PII.
 */
const PROTOCOL_KEYS: ReadonlySet<string> = new Set([
  'event_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'segment_id',
  'sample_rand',
  'sample_rate',
]);

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return TRUNCATED;
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        PROTOCOL_KEYS.has(key) && typeof inner === 'string' ? inner : scrubValue(inner, depth + 1),
      ]),
    );
  }
  return value;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return scrubText(cut === -1 ? url : url.slice(0, cut));
}

export type ScrubbableEvent = {
  message?: string;
  exception?: { values?: { value?: string }[] };
  request?: {
    url?: string;
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    query_string?: unknown;
  };
  user?: { id?: string | number } & Record<string, unknown>;
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  /** SDK-internal (dynamic sampling context, captured scopes). Passed through as is. */
  sdkProcessingMetadata?: unknown;
};

type Loose = Record<string, unknown>;

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const allowed: readonly string[] = ALLOWED_HEADERS;
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => allowed.includes(name.toLowerCase()))
      .map(([name, value]) => [name, scrubText(String(value))]),
  );
}

function scrubRequest(request: NonNullable<ScrubbableEvent['request']>): Loose {
  const { data: _data, cookies: _cookies, query_string: _query, headers, url, ...rest } = request;
  const kept = scrubValue(rest, 0) as Loose;
  return {
    ...kept,
    ...(url === undefined ? {} : { url: stripQuery(url) }),
    ...(headers === undefined ? {} : { headers: scrubHeaders(headers) }),
  };
}

function scrubBreadcrumb(crumb: NonNullable<ScrubbableEvent['breadcrumbs']>[number]): Loose {
  const { data, message, ...rest } = crumb;
  const out = scrubValue(rest, 1) as Loose;
  if (message !== undefined) out.message = scrubText(message);
  if (data !== undefined) {
    const scrubbed = scrubValue(data, 1) as Loose;
    if (typeof data.url === 'string') scrubbed.url = stripQuery(data.url);
    out.data = scrubbed;
  }
  return out;
}

/**
 * Returns a scrubbed copy of a Sentry-shaped event. Never mutates its input.
 * `sdkProcessingMetadata` is the SDK's own state (the envelope trace header is built from it, and
 * it holds Scope instances), so it is passed through by reference, never scrubbed or copied.
 */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const { sdkProcessingMetadata, ...rest } = event;
  const out: Loose = { ...(scrubValue(rest, -1) as Loose) };
  if ('sdkProcessingMetadata' in event) out.sdkProcessingMetadata = sdkProcessingMetadata;
  // Fields with dedicated rules are rebuilt from the original, not the generic copy.
  if (event.request !== undefined) out.request = scrubRequest(event.request);
  if (event.user !== undefined) {
    out.user = event.user.id === undefined ? {} : { id: event.user.id };
  }
  if (event.breadcrumbs !== undefined) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return out as T;
}

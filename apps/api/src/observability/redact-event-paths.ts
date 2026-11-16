import { REDACTED_SEGMENT, redactPath } from '../lib/redact-path';

/**
 * Applies `redactPath` to every place a Sentry event can carry the request path: the transaction
 * name, `request.url`, URL-ish span/trace data keys and method-plus-path span descriptions.
 * Returns a copy; `sdkProcessingMetadata` and every other field are passed through by reference.
 */

const URL_DATA_KEYS = ['url.full', 'url.path', 'http.target', 'http.url', 'http.route'] as const;
/** `GET /api/…`: an HTTP method, one space, then a path. */
const METHOD_AND_PATH = /^([A-Z]+) (\/\S*)$/;

type Loose = Record<string, unknown>;

type PathBearingSpan = { description?: string; data?: Loose };

/** The fields this module reads; Sentry's ErrorEvent and TransactionEvent both fit. */
export type PathBearingEvent = {
  transaction?: string;
  request?: { url?: string };
  contexts?: { trace?: { data?: Loose } };
  spans?: PathBearingSpan[];
};

/** A full URL keeps its origin and loses its query; a path is redacted; anything else is dropped. */
function redactUrlish(value: string): string {
  if (value.startsWith('/')) return redactPath(value);
  try {
    const url = new URL(value);
    return `${url.origin}${redactPath(url.pathname)}`;
  } catch {
    return REDACTED_SEGMENT;
  }
}

function redactMethodAndPath(value: string): string {
  const match = METHOD_AND_PATH.exec(value);
  if (match) return `${match[1]} ${redactPath(match[2] ?? '')}`;
  return value.startsWith('/') ? redactPath(value) : value;
}

function redactData(data: Loose): Loose {
  const out: Loose = { ...data };
  for (const key of URL_DATA_KEYS) {
    const value = data[key];
    if (typeof value === 'string') out[key] = redactUrlish(value);
  }
  return out;
}

function redactSpan(span: PathBearingSpan): PathBearingSpan {
  return {
    ...span,
    ...(typeof span.description === 'string'
      ? { description: redactMethodAndPath(span.description) }
      : {}),
    ...(span.data ? { data: redactData(span.data) } : {}),
  };
}

export function redactEventPaths<T extends PathBearingEvent>(event: T): T {
  const { transaction, request, contexts, spans } = event;
  const trace = contexts?.trace;
  const out: PathBearingEvent = {
    ...event,
    ...(typeof transaction === 'string' ? { transaction: redactMethodAndPath(transaction) } : {}),
    ...(request && typeof request.url === 'string'
      ? { request: { ...request, url: redactUrlish(request.url) } }
      : {}),
    ...(contexts && trace?.data
      ? { contexts: { ...contexts, trace: { ...trace, data: redactData(trace.data) } } }
      : {}),
    ...(Array.isArray(spans) ? { spans: spans.map(redactSpan) } : {}),
  };
  // Same shape as the input: only string values were replaced.
  return out as T;
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppEnvironment } from '../env';

type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

/** Deepest `cause` level that is serialized. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Full error detail (message, stack) is for local development only. Everywhere else messages are
 * redacted and stacks omitted: Drizzle puts bound query values (`params: …`) in its message, and
 * the first stack line repeats the message. Those values include phone numbers, names and session
 * tokens. The default is the safe mode until configureLogging says otherwise.
 */
let verbose = false;

export function configureLogging(options: { appEnv: AppEnvironment }): void {
  verbose = options.appEnv === 'development';
}

/** Drops everything from a `params:` marker on: Drizzle appends the bound values there. */
export function redactMessage(message: string): string {
  const at = message.search(/\bparams:/i);
  return (at === -1 ? message : `${message.slice(0, at)}params: [redacted]`).trim();
}

function errorProperty(error: Error, key: 'code' | 'constraint'): string | undefined {
  const value = (error as Error & Record<typeof key, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Errors do not JSON-serialize on their own. Safe mode keeps, for each `cause` level, the name,
 * the pg `code` and `constraint`, and the redacted message. Never `detail`, `params`, or the stack.
 */
export function serializeError(error: Error, depth = 0, fullDetail = verbose): LogFields {
  const cause =
    error.cause instanceof Error && depth < MAX_CAUSE_DEPTH
      ? serializeError(error.cause, depth + 1, fullDetail)
      : undefined;
  return {
    name: error.name,
    code: errorProperty(error, 'code'),
    constraint: errorProperty(error, 'constraint'),
    message: fullDetail ? error.message : redactMessage(error.message),
    stack: fullDetail ? error.stack : undefined,
    cause,
  };
}

function serialize(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

export interface LogContext {
  requestId?: string;
}

const logContext = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `fields` attached to every log line emitted inside it. */
export function withLogContext<T>(fields: { requestId: string }, fn: () => T): T {
  return logContext.run(fields, fn);
}

export function currentLogContext(): LogContext {
  return logContext.getStore() ?? {};
}

function emit(level: Level, msg: string, fields: LogFields = {}): void {
  const extra = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, serialize(v)]));
  const entry = { ...currentLogContext(), ...extra, level, msg, time: new Date().toISOString() };
  // biome-ignore lint/suspicious/noConsole: the one sink for structured logs; Workers Logs ingest console output.
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(JSON.stringify(entry));
}

/** Structured JSON logger. The only module allowed to touch `console`. */
export const logger = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
export type Logger = typeof logger;

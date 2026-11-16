import { z } from '@hono/zod-openapi';
import { err, ok, type Result } from '@knoqra/core';
import { safeText } from './schemas';

export interface CursorValue {
  /** lower(display_name) of the last row on the previous page. */
  name: string;
  id: string;
}

const CursorPayload = z.object({
  n: safeText({ trim: false }),
  i: safeText({ min: 1, trim: false }),
});

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/** Opaque keyset cursor: base64url JSON `{ n, i }`. */
export function encodeCursor(value: CursorValue): string {
  return toBase64Url(JSON.stringify({ n: value.name, i: value.id }));
}

export interface TimelineCursorValue {
  /** occurred_at of the last row on the previous page, ISO 8601 UTC with microsecond precision. */
  occurredAt: string;
  id: string;
}

/** Date.parse rolls 2026-02-30 over to March, so compare the date parts after a round trip. */
function isRealCalendarTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
  );
}

const TimelineCursorPayload = z.object({
  o: safeText({ min: 1, max: 40, trim: false })
    .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
    .refine(isRealCalendarTimestamp),
  i: safeText({ min: 1, max: 64, trim: false }),
});

/** Opaque keyset cursor for the timeline: base64url JSON `{ o, i }`. */
export function encodeTimelineCursor(value: TimelineCursorValue): string {
  return toBase64Url(JSON.stringify({ o: value.occurredAt, i: value.id }));
}

/** Never throws: any malformed input is `invalid_cursor`. */
export function decodeTimelineCursor(
  cursor: string,
): Result<TimelineCursorValue, 'invalid_cursor'> {
  try {
    const parsed = TimelineCursorPayload.safeParse(JSON.parse(fromBase64Url(cursor)));
    return parsed.success
      ? ok({ occurredAt: parsed.data.o, id: parsed.data.i })
      : err('invalid_cursor');
  } catch {
    return err('invalid_cursor');
  }
}

/** Never throws: any malformed input is `invalid_cursor`. */
export function decodeCursor(cursor: string): Result<CursorValue, 'invalid_cursor'> {
  try {
    const parsed = CursorPayload.safeParse(JSON.parse(fromBase64Url(cursor)));
    return parsed.success ? ok({ name: parsed.data.n, id: parsed.data.i }) : err('invalid_cursor');
  } catch {
    return err('invalid_cursor');
  }
}

export type TaskCursorValue =
  | { status: 'open'; due: string; createdAt: string; id: string }
  | { status: 'done'; completedAt: string; id: string };

const TIMESTAMP_TEXT = safeText({ min: 1, max: 40, trim: false })
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  .refine(isRealCalendarTimestamp);

const TaskCursorPayload = z.discriminatedUnion('s', [
  z.object({
    s: z.literal('open'),
    d: z.union([z.literal('infinity'), TIMESTAMP_TEXT]),
    c: TIMESTAMP_TEXT,
    i: safeText({ min: 1, max: 64, trim: false }),
  }),
  z.object({
    s: z.literal('done'),
    c: TIMESTAMP_TEXT,
    i: safeText({ min: 1, max: 64, trim: false }),
  }),
]);

/** Opaque keyset cursor for tasks. The status is part of the payload so it cannot cross lists. */
export function encodeTaskCursor(value: TaskCursorValue): string {
  return toBase64Url(
    JSON.stringify(
      value.status === 'open'
        ? { s: 'open', d: value.due, c: value.createdAt, i: value.id }
        : { s: 'done', c: value.completedAt, i: value.id },
    ),
  );
}

/** Never throws: any malformed input is `invalid_cursor`. */
export function decodeTaskCursor(cursor: string): Result<TaskCursorValue, 'invalid_cursor'> {
  try {
    const parsed = TaskCursorPayload.safeParse(JSON.parse(fromBase64Url(cursor)));
    if (!parsed.success) return err('invalid_cursor');
    const v = parsed.data;
    return ok(
      v.s === 'open'
        ? { status: 'open', due: v.d, createdAt: v.c, id: v.i }
        : { status: 'done', completedAt: v.c, id: v.i },
    );
  } catch {
    return err('invalid_cursor');
  }
}

export interface ConversationCursorValue {
  /** last_activity_at of the last row on the previous page, ISO 8601 UTC with microsecond precision. */
  lastActivityAt: string;
  id: string;
}

/** Opaque keyset cursor for the conversation list; same wire shape as the timeline cursor. */
export function encodeConversationCursor(value: ConversationCursorValue): string {
  return encodeTimelineCursor({ occurredAt: value.lastActivityAt, id: value.id });
}

/** Never throws: any malformed input is `invalid_cursor`. */
export function decodeConversationCursor(
  cursor: string,
): Result<ConversationCursorValue, 'invalid_cursor'> {
  const decoded = decodeTimelineCursor(cursor);
  return decoded.ok
    ? ok({ lastActivityAt: decoded.value.occurredAt, id: decoded.value.id })
    : err('invalid_cursor');
}

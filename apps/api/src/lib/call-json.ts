import { z } from '@hono/zod-openapi';
import { CALL_OUTCOMES, CALL_STATES } from '@knoqra/core';
import { type CallRow, call, contact, type Tx } from '@knoqra/db';
import { and, eq, type SQL } from 'drizzle-orm';

export const CALL_ID_PATTERN = /^cl_[0-9a-f]{32}$/;

export const CallContactSchema = z
  .object({ id: z.string(), displayName: z.string() })
  .openapi('CallContact');

export const CallSchema = z
  .object({
    id: z.string().openapi({ example: 'cl_0123456789abcdef0123456789abcdef' }),
    /** The workspace member the call belongs to (who dialed it, or who it rings). */
    userId: z.string(),
    direction: z.enum(['outbound', 'inbound']),
    state: z.enum(CALL_STATES),
    contact: CallContactSchema.nullable(),
    fromE164: z.string(),
    toE164: z.string(),
    createdAt: z.iso.datetime(),
    answeredAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    billableSeconds: z.number().int().nullable(),
    costMicros: z.number().int().nullable(),
    hangupCause: z.string().nullable(),
    outcome: z.enum(CALL_OUTCOMES).nullable(),
    outcomeNote: z.string().nullable(),
    reviewConfirmed: z.boolean(),
  })
  .openapi('Call');
export type CallJson = z.infer<typeof CallSchema>;

/** A call row with its contact (null when there is none, or it was deleted). */
export interface CallWithContact {
  row: CallRow;
  contact: { id: string; displayName: string } | null;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toCallJson({ row, contact: who }: CallWithContact): CallJson {
  return {
    id: row.id,
    userId: row.userId,
    direction: row.direction,
    state: row.state,
    contact: who,
    fromE164: row.fromE164,
    toE164: row.toE164,
    createdAt: row.createdAt.toISOString(),
    answeredAt: iso(row.answeredAt),
    endedAt: iso(row.endedAt),
    billableSeconds: row.billableSeconds,
    costMicros: row.costMicros,
    hangupCause: row.hangupCause,
    outcome: row.outcome,
    outcomeNote: row.outcomeNote,
    reviewConfirmed: row.reviewConfirmed,
  };
}

/** Calls joined to their contact on the tenant-composite key (RLS-scoped `tx`). */
export function selectCalls(tx: Tx) {
  return tx
    .select({
      row: call,
      contactId: contact.id,
      contactName: contact.displayName,
    })
    .from(call)
    .leftJoin(
      contact,
      and(eq(contact.organizationId, call.organizationId), eq(contact.id, call.contactId)),
    );
}

type JoinedRow = { row: CallRow; contactId: string | null; contactName: string | null };

export function fromJoined(joined: JoinedRow): CallWithContact {
  return {
    row: joined.row,
    contact:
      joined.contactId !== null && joined.contactName !== null
        ? { id: joined.contactId, displayName: joined.contactName }
        : null,
  };
}

/** One call with its contact, or undefined. */
export async function findCallWithContact(
  tx: Tx,
  where: SQL | undefined,
): Promise<CallWithContact | undefined> {
  const [joined] = await selectCalls(tx).where(where).limit(1);
  return joined ? fromJoined(joined) : undefined;
}

/** The call as JSON after a write, read back with its contact. */
export async function callJsonById(tx: Tx, id: string): Promise<CallJson> {
  const found = await findCallWithContact(tx, eq(call.id, id));
  if (!found) throw new Error('call vanished inside its own transaction');
  return toCallJson(found);
}

import { newId, normalizePhone } from '@knoqra/core';
import {
  call,
  callRoute,
  contact,
  type Database,
  member,
  providerNumberRoute,
  type Tx,
} from '@knoqra/db';
import type { NormalizedCallEvent } from '@knoqra/providers';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from '../env';

/** The constraint a concurrent first create of the same inbound call loses on. */
export const CALL_ROUTE_PROVIDER_ID_UNIQUE = 'call_route_provider_provider_call_id_unique';

/**
 * The organization a new inbound call belongs to: the fake provider's org hint (outside production
 * only) wins; otherwise the dialed number's provider_number_route.
 */
export async function inboundOrg(
  db: Database,
  env: Pick<Env, 'APP_ENV'>,
  event: NormalizedCallEvent,
): Promise<string | null> {
  const hintAllowed = event.provider === 'fake' && env.APP_ENV !== 'production';
  if (hintAllowed && event.orgHint) return event.orgHint;
  const [numberRoute] = await db
    .select({ orgId: providerNumberRoute.organizationId })
    .from(providerNumberRoute)
    .where(
      and(eq(providerNumberRoute.provider, event.provider), eq(providerNumberRoute.e164, event.to)),
    )
    .limit(1);
  return numberRoute?.orgId ?? null;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** The organization's oldest owner (Better Auth stores several roles comma-separated). */
async function ownerOf(tx: Tx, orgId: string): Promise<string | null> {
  const [owner] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, orgId),
        sql`'owner' = any(string_to_array(replace(${member.role}, ' ', ''), ','))`,
      ),
    )
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  return owner?.userId ?? null;
}

/** A live (not archived, not merged) contact of the organization with this number. */
async function contactFor(tx: Tx, orgId: string, phoneE164: string): Promise<string | null> {
  const [match] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, orgId),
        eq(contact.phoneE164, phoneE164),
        isNull(contact.archivedAt),
        isNull(contact.mergedIntoId),
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

/**
 * Creates an inbound call and its route, ringing the organization's owner and matched to a contact
 * by the caller's number. No reservation: answering reserves. Returns null when the organization
 * has no owner. A concurrent create for the same provider call id fails on
 * CALL_ROUTE_PROVIDER_ID_UNIQUE; the caller then resolves the winner's route.
 */
export async function createInboundCall(
  tx: Tx,
  orgId: string,
  event: NormalizedCallEvent,
): Promise<string | null> {
  const ownerId = await ownerOf(tx, orgId);
  if (ownerId === null) return null;
  const phone = normalizePhone(event.from);
  const contactId = phone.ok ? await contactFor(tx, orgId, phone.value) : null;
  const id = newId('cl');
  const clientState = randomHex(16);
  await tx.insert(call).values({
    id,
    organizationId: orgId,
    userId: ownerId,
    contactId,
    direction: 'inbound',
    state: 'queued',
    fromE164: phone.ok ? phone.value : event.from,
    toE164: event.to,
    provider: event.provider,
    providerCallId: event.providerCallId,
    clientState,
  });
  await tx.insert(callRoute).values({
    clientState,
    organizationId: orgId,
    callId: id,
    provider: event.provider,
    providerCallId: event.providerCallId,
  });
  return id;
}

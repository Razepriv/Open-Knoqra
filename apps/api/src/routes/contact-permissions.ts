import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  CHANNELS,
  type Channel,
  currentPermissions,
  evaluateChannel,
  PERMISSION_STATUSES,
  type PermissionStatus,
} from '@knoqra/core';
import {
  type ContactPermissionEvent,
  contactPermissionEvent,
  type PermissionSource,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import { inArray, type SQL, sql } from 'drizzle-orm';
import {
  auditContactAlone,
  CONTACT_ID_PATTERN,
  ContactIdParam,
  findContact,
  insertContactAudit,
  notFound,
  refuseAccess,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { latestPermissionEvents } from '../lib/permissions';
import { safeText } from '../lib/schemas';

const MAX_EVIDENCE_LENGTH = 500;
export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 500;

const CHANNEL_LABELS: Record<Channel, string> = {
  manual_call: 'Calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  ai_voice: 'AI voice',
  recording: 'Recording',
};

const STATUS_PHRASES: Record<PermissionStatus, string> = {
  granted: 'granted',
  revoked: 'revoked',
  opted_out: 'set to opted out',
  do_not_contact: 'set to do not contact',
};

/** The status as it reads after "kept as" in a merge timeline title. */
const KEPT_PHRASES: Record<PermissionStatus, string> = {
  granted: 'granted',
  revoked: 'revoked',
  opted_out: 'opted out',
  do_not_contact: 'do not contact',
};

/** Higher is more restrictive. No record (unknown) ranks below every status. */
const RESTRICTIVENESS: Record<PermissionStatus, number> = {
  granted: 1,
  revoked: 2,
  opted_out: 3,
  do_not_contact: 4,
};
const restrictiveness = (status: PermissionStatus | undefined): number =>
  status === undefined ? 0 : RESTRICTIVENESS[status];

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

export const ChannelPermissionSchema = z
  .object({
    channel: z.enum(CHANNELS),
    status: z.enum([...PERMISSION_STATUSES, 'unknown']),
    decision: DecisionSchema,
    source: z.string().nullable(),
    evidence: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  })
  .openapi('ChannelPermission');
type ChannelPermissionJson = z.infer<typeof ChannelPermissionSchema>;

const ContactPermissionsSchema = z
  .object({ channels: z.array(ChannelPermissionSchema) })
  .openapi('ContactPermissions');

const ChannelParams = ContactIdParam.extend({
  channel: z.enum(CHANNELS).openapi({ param: { name: 'channel', in: 'path' } }),
});

const Evidence = safeText({ max: MAX_EVIDENCE_LENGTH }).optional();

// Blank (after trimming) means "no reason", so a lift without one gets the specific 422 below.
const Reason = safeText({ max: MAX_REASON_LENGTH })
  .refine(
    (value) => value === '' || value.length >= MIN_REASON_LENGTH,
    `Reason must be at least ${MIN_REASON_LENGTH} characters`,
  )
  .optional()
  .openapi({
    description:
      'Why consent is changing, 5 to 500 characters. Required to grant a channel that is do not contact. Stored as the evidence of the change, so send it instead of evidence, not with it.',
  });

const SetPermissionBody = z
  .object({ status: z.enum(PERMISSION_STATUSES), evidence: Evidence, reason: Reason })
  .openapi('SetChannelPermission');
const DoNotContactBody = z.object({ evidence: Evidence }).openapi('DoNotContact');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/contacts/{id}/permissions',
  tags: ['contacts'],
  summary: "A contact's current permission and send decision for every channel",
  security,
  request: { params: ContactIdParam },
  responses: {
    200: { description: 'Permissions', content: json(okEnvelope(ContactPermissionsSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/api/v1/contacts/{id}/permissions/{channel}',
  tags: ['contacts'],
  summary: "Record a contact's consent change for one channel",
  security,
  request: { params: ChannelParams, body: { required: true, content: json(SetPermissionBody) } },
  responses: {
    200: { description: 'Updated channel', content: json(okEnvelope(ChannelPermissionSchema)) },
    400: errorResponse('Unknown channel or invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse(
      'The contact is archived or merged, or a reason is required to lift do not contact',
    ),
  },
});

const dncRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/do-not-contact',
  tags: ['contacts'],
  summary: 'Mark a contact do not contact on every channel',
  security,
  request: { params: ContactIdParam, body: { required: false, content: json(DoNotContactBody) } },
  responses: {
    200: { description: 'Permissions', content: json(okEnvelope(ContactPermissionsSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('The contact is archived or merged'),
  },
});

function toChannelJson(
  channel: Channel,
  event: ContactPermissionEvent | undefined,
  status: PermissionStatus | undefined,
): ChannelPermissionJson {
  return {
    channel,
    status: status ?? 'unknown',
    decision: evaluateChannel(channel, status),
    source: event?.source ?? null,
    evidence: event?.evidence ?? null,
    updatedAt: event?.createdAt.toISOString() ?? null,
  };
}

/** Builds all five channel rows from the latest event of each channel. */
function toPermissionsJson(latest: readonly ContactPermissionEvent[]): {
  channels: ChannelPermissionJson[];
} {
  const statuses = currentPermissions(latest);
  const byChannel = new Map(latest.map((event) => [event.channel, event]));
  return {
    channels: CHANNELS.map((channel) =>
      toChannelJson(channel, byChannel.get(channel), statuses[channel]),
    ),
  };
}

const blankToNull = (value: string | undefined): string | null =>
  value === undefined || value === '' ? null : value;

/**
 * Owner rule (2026-11-13, closes M1-R12): granting a channel whose current status is
 * `do_not_contact` lifts it, and that needs a written reason. Every other transition does not.
 * Inbound START and merges never come through here: START is the contact's own consent.
 */
export const liftsDoNotContact = (
  current: PermissionStatus | undefined,
  next: PermissionStatus,
): boolean => current === 'do_not_contact' && next === 'granted';

const REASON_REQUIRED_MESSAGE =
  'This channel is marked do not contact. Add a reason (how they gave consent again) to grant it.';

function consentTitle(channel: Channel, status: PermissionStatus, lifted: boolean): string {
  const base = `${CHANNEL_LABELS[channel]} consent ${STATUS_PHRASES[status]}`;
  return lifted ? `${base} (do-not-contact lifted)` : base;
}

async function recordConsentEvents(
  tx: Tx,
  tenant: Tenant,
  contactId: string,
  channels: readonly Channel[],
  status: PermissionStatus,
  evidence: string | null,
  source: PermissionSource = 'manual',
  stampedAt: SQL = sql`clock_timestamp()`,
): Promise<ContactPermissionEvent[]> {
  // clock_timestamp(), not now(): the contact row lock serialises writers, and now() is the
  // transaction start, which could order a waiting writer before the one it waited for.
  const events = await tx
    .insert(contactPermissionEvent)
    .values(
      channels.map((channel) => ({
        organizationId: tenant.orgId,
        contactId,
        channel,
        status,
        source,
        evidence,
        actorUserId: tenant.userId,
        createdAt: stampedAt as unknown as Date,
      })),
    )
    .returning();
  if (events.length !== channels.length) throw new Error('permission insert returned no row');
  return events;
}

/** A channel whose status a merge must re-assert on the target. */
export interface KeptConsent {
  channel: Channel;
  status: PermissionStatus;
}

/** Status per channel from at most one event per channel, as `latestPermissionEvents` gives. */
const statusByChannel = (
  latest: readonly ContactPermissionEvent[],
): Partial<Record<Channel, PermissionStatus>> =>
  Object.fromEntries(latest.map((event) => [event.channel, event.status]));

/**
 * Merge rule for consent: per channel, the target keeps the more restrictive of the two
 * contacts' current statuses (do_not_contact > opted_out > revoked > granted > none). Re-pointing
 * alone would make the newest event of the combined history win, so a newer grant on one contact
 * could lift an opt-out or do-not-contact on the other. Returns the channels where that would
 * happen. Call it with both rows locked and before the source's history is re-pointed.
 *
 * Every status here comes from the database's own (created_at desc, id desc) order, including
 * the combined one, so ties and sub-millisecond differences resolve exactly as reads will.
 */
export async function consentToKeepOnMerge(
  tx: Tx,
  targetId: string,
  sourceId: string,
): Promise<KeptConsent[]> {
  const target = statusByChannel(await latestPermissionEvents(tx, targetId));
  const source = statusByChannel(await latestPermissionEvents(tx, sourceId));
  const combined = statusByChannel(await latestPermissionEvents(tx, targetId, sourceId));
  return CHANNELS.flatMap((channel) => {
    const keep =
      restrictiveness(source[channel]) > restrictiveness(target[channel])
        ? source[channel]
        : target[channel];
    if (keep === undefined) return [];
    return restrictiveness(keep) > restrictiveness(combined[channel])
      ? [{ channel, status: keep }]
      : [];
  });
}

/**
 * Stamp for a kept-consent event: strictly after every event of either contact, even one stamped
 * ahead of this host's clock (a clock step back, a failover to a host that runs behind), so the
 * `merge` event is always the channel's latest in the (created_at desc, id desc) order.
 */
const afterEveryEventOf = (targetId: string, sourceId: string): SQL =>
  sql`greatest(clock_timestamp(), (select max(${contactPermissionEvent.createdAt}) from ${contactPermissionEvent} where ${inArray(contactPermissionEvent.contactId, [targetId, sourceId])}) + interval '1 microsecond')`;

/**
 * Appends a `merge` consent event (and a consent timeline event) on the target for each kept
 * channel, stamped after every existing event of either contact so it is the channel's latest
 * event. The caller holds both row locks (the consent invariant).
 */
export async function recordKeptConsent(
  tx: Tx,
  tenant: Tenant,
  targetId: string,
  sourceId: string,
  kept: readonly KeptConsent[],
): Promise<void> {
  for (const { channel, status } of kept) {
    const [event] = await recordConsentEvents(
      tx,
      tenant,
      targetId,
      [channel],
      status,
      null,
      'merge',
      afterEveryEventOf(targetId, sourceId),
    );
    if (!event) throw new Error('permission insert returned no row');
    await tx.insert(timelineEvent).values({
      organizationId: tenant.orgId,
      contactId: targetId,
      kind: 'consent',
      title: `${CHANNEL_LABELS[channel]} consent kept as ${KEPT_PHRASES[status]} after merge`,
      actorUserId: tenant.userId,
      source: 'app',
      refType: 'contact_permission_event',
      refId: event.id,
      occurredAt: sql`clock_timestamp()`,
    });
  }
}

export const contactPermissions = new OpenAPIHono<AppEnv>()
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.permission.read');
    }
    const latest = await withTenant(db, tenant.orgId, async (tx) =>
      (await findContact(tx, id, false)) ? latestPermissionEvents(tx, id) : undefined,
    );
    if (!latest) return notFound(c, db, tenant, 'contact.permission.read', id);
    return ok(c, toPermissionsJson(latest), 200);
  })
  .openapi(putRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id, channel } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.permission.change');
    }
    const body = c.req.valid('json');
    const reason = blankToNull(body.reason);
    const evidence = blankToNull(body.evidence);
    if (reason !== null && evidence !== null) {
      return fail(c, 400, 'validation_error', 'Send a reason or evidence, not both.');
    }
    const { status } = body;
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const access = writableAccess(await findContact(tx, id, true));
      if (access.kind !== 'ok') return { refused: access.kind } as const;
      const current = (await latestPermissionEvents(tx, id)).find((e) => e.channel === channel);
      const lifted = liftsDoNotContact(current?.status, status);
      if (lifted && reason === null) return { reasonRequired: true } as const;
      const [event] = await recordConsentEvents(
        tx,
        tenant,
        id,
        [channel],
        status,
        reason ?? evidence,
      );
      if (!event) throw new Error('permission insert returned no row');
      await tx.insert(timelineEvent).values({
        organizationId: tenant.orgId,
        contactId: id,
        kind: 'consent',
        title: consentTitle(channel, status, lifted),
        body: reason,
        actorUserId: tenant.userId,
        source: 'app',
        refType: 'contact_permission_event',
        refId: event.id,
        occurredAt: sql`clock_timestamp()`,
      });
      // Never the evidence text: it is PII. The reason is the owner's audited justification.
      await insertContactAudit(tx, tenant, {
        action: 'contact.permission.change',
        outcome: 'allowed',
        entityId: id,
        metadata: {
          channel,
          status,
          ...(lifted ? { previousStatus: 'do_not_contact', doNotContactLifted: true } : {}),
          ...(reason === null ? {} : { reason }),
        },
      });
      return { event } as const;
    });
    if (result.refused) {
      return refuseAccess(c, db, tenant, 'contact.permission.change', id, result.refused);
    }
    if (result.reasonRequired) {
      await auditContactAlone(db, tenant, {
        action: 'contact.permission.change',
        outcome: 'denied',
        entityId: id,
        metadata: { reason: 'consent_reason_required', channel, status },
      });
      return fail(c, 422, 'consent_reason_required', REASON_REQUIRED_MESSAGE);
    }
    return ok(c, toChannelJson(channel, result.event, result.event.status), 200);
  })
  .openapi(dncRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.permission.do_not_contact');
    }
    const { evidence } = c.req.valid('json') ?? {};
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const access = writableAccess(await findContact(tx, id, true));
      if (access.kind !== 'ok') return { refused: access.kind } as const;
      const events = await recordConsentEvents(
        tx,
        tenant,
        id,
        CHANNELS,
        'do_not_contact',
        blankToNull(evidence),
      );
      await tx.insert(timelineEvent).values({
        organizationId: tenant.orgId,
        contactId: id,
        kind: 'consent',
        title: 'Marked do not contact on all channels',
        actorUserId: tenant.userId,
        source: 'app',
        occurredAt: sql`clock_timestamp()`,
      });
      await insertContactAudit(tx, tenant, {
        action: 'contact.permission.do_not_contact',
        outcome: 'allowed',
        entityId: id,
        metadata: { channels: CHANNELS.length },
      });
      return { events } as const;
    });
    if (result.refused) {
      return refuseAccess(c, db, tenant, 'contact.permission.do_not_contact', id, result.refused);
    }
    return ok(c, toPermissionsJson(result.events), 200);
  });

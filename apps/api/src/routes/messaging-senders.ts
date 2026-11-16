import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  MESSAGING_CHANNELS,
  type MessagingChannel,
  normalizePhone,
  REGISTRATION_STATUSES,
  type RegistrationStatus,
} from '@knoqra/core';
import {
  channelConnection,
  channelRoute,
  messageTemplate,
  type ProviderCredentialRow,
  providerCredential,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { TelnyxMessagingError, TelnyxMessagingProvider } from '@knoqra/providers';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '../env';
import type { AppEnv, Tenant } from '../lib/context';
import { type ErrorCode, errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { canManage } from '../lib/roles';
import { isValidMasterKey } from '../lib/secret-envelope';
import { auditMessagingAlone, insertMessagingAudit } from '../messaging/audit';
import {
  listSenders,
  openTelnyxKey,
  SANDBOX_PREFIX,
  syncedTelnyxNumber,
} from '../messaging/senders';
import { lockNumbers } from '../services/numbers';
import {
  registrationIsSynced,
  sendableFor,
  smsRegistration,
} from '../services/sender-registration';
import { adapterFor } from './webhooks';

const SenderSchema = z
  .object({
    id: z.string(),
    channel: z.enum(MESSAGING_CHANNELS),
    provider: z.enum(['fake', 'telnyx']),
    address: z.string(),
    registrationStatus: z.enum(REGISTRATION_STATUSES),
    sandbox: z.boolean(),
    liveEnabled: z.boolean(),
  })
  .openapi('MessagingSender');

const SendersSchema = z
  .object({
    items: z.array(SenderSchema),
    sandboxAvailable: z.boolean(),
    /** Whether this deployment sends through Telnyx at all (PROVIDER=telnyx). */
    liveAvailable: z.boolean(),
  })
  .openapi('MessagingSenders');
const SandboxBody = z
  .object({ sms: z.enum(REGISTRATION_STATUSES), whatsapp: z.enum(REGISTRATION_STATUSES) })
  .openapi('UpdateSandbox');
const SandboxResult = z.object({ items: z.array(SenderSchema) }).openapi('SandboxSenders');
/**
 * SMS takes its registration status from the synced number's 10DLC state (ruling AQ), so a
 * `registrationStatus` for SMS is refused with 400 rather than silently dropped. WhatsApp needs one:
 * the owner or admin sets it until M4's sync reads Meta's state from Telnyx (ruling AR).
 */
const SenderBody = z
  .object({
    /** E.164. Defaults to the caller id saved with the Telnyx credential. */
    address: z.string().min(1).max(32).optional(),
    /** WhatsApp only, and required there. SMS follows the synced 10DLC state. */
    registrationStatus: z.enum(REGISTRATION_STATUSES).optional(),
  })
  .openapi('UpdateSender');
const ChannelParam = z.object({
  channel: z.enum(MESSAGING_CHANNELS).openapi({ param: { name: 'channel', in: 'path' } }),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/messaging/senders',
  tags: ['messaging'],
  summary: 'Senders of the active organization',
  security,
  responses: {
    200: { description: 'Senders', content: json(okEnvelope(SendersSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const sandboxRoute = createRoute({
  method: 'put',
  path: '/api/v1/messaging/sandbox',
  tags: ['messaging'],
  summary: 'Create or update the sandbox senders (staging and development only)',
  security,
  request: { body: { required: true, content: json(SandboxBody) } },
  responses: {
    200: { description: 'Sandbox senders', content: json(okEnvelope(SandboxResult)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse('The sandbox is not available here'),
    409: errorResponse('No active organization'),
    422: errorResponse('The channel already has a live sender'),
  },
});

const senderRoute = createRoute({
  method: 'put',
  path: '/api/v1/messaging/senders/{channel}',
  tags: ['messaging'],
  summary:
    'Register an active synced number of your Telnyx account as the live sender of a channel (owners and admins); SMS status follows the synced number, WhatsApp status is set in the body',
  security,
  request: { params: ChannelParam, body: { required: true, content: json(SenderBody) } },
  responses: {
    200: { description: 'Senders', content: json(okEnvelope(SandboxResult)) },
    400: errorResponse(
      'Invalid body, no valid address, a registration status for SMS, or none for WhatsApp',
    ),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can change senders'),
    409: errorResponse(
      "The number can't be used as a sender, the Telnyx connection changed while saving, or no active organization",
    ),
    422: errorResponse(
      'Live sending is not available here, no Telnyx credential is saved, the number is not an active synced number for the channel, Telnyx refused the saved key, or the number is not in that Telnyx account',
    ),
    500: errorResponse('The saved Telnyx key could not be read'),
    502: errorResponse('Telnyx could not be reached'),
    503: errorResponse('Credentials are not configured on this server'),
  },
});

const FORBIDDEN_COPY = 'Only owners and admins can change senders.';

/** Why a sender change was refused: the audit reason, then the HTTP answer and our copy. */
const SENDER_REFUSALS = {
  live_unavailable: {
    status: 422,
    code: 'not_configured',
    copy: "Live sending isn't available on this deployment.",
  },
  no_credential: { status: 422, code: 'validation_error', copy: 'Connect Telnyx first.' },
  address_required: {
    status: 400,
    code: 'validation_error',
    copy: 'address: Enter the number to send from, like +1 202 555 0123.',
  },
  address_invalid: {
    status: 400,
    code: 'validation_error',
    copy: 'address: Enter a valid phone number',
  },
  status_synced: {
    status: 400,
    code: 'validation_error',
    copy: 'registrationStatus: The SMS status comes from your synced numbers.',
  },
  status_required: {
    status: 400,
    code: 'validation_error',
    copy: 'registrationStatus: Choose the WhatsApp registration status.',
  },
  not_configured: {
    status: 503,
    code: 'not_configured',
    copy: 'Live sending is not configured on this server.',
  },
  credential_unreadable: { status: 500, code: 'internal_error', copy: 'Something went wrong.' },
  provider_auth: {
    status: 422,
    code: 'provider_auth',
    copy: 'Telnyx did not accept the saved API key.',
  },
  provider_error: {
    status: 502,
    code: 'internal_error',
    copy: 'Telnyx could not be reached. Try again in a moment.',
  },
  not_synced: {
    status: 422,
    code: 'number_not_synced',
    copy: 'Sync your numbers, then choose an active Telnyx number.',
  },
  not_capable: {
    status: 422,
    code: 'number_not_synced',
    copy: "This number can't send on this channel in Telnyx.",
  },
  not_owned: {
    status: 422,
    code: 'number_not_owned',
    copy: "This number isn't in your Telnyx account.",
  },
  credential_changed: {
    status: 409,
    code: 'credential_changed',
    copy: 'The Telnyx connection changed while saving. Try again.',
  },
  // Generic on purpose, like voice's NUMBER_CONFLICT: it must not reveal another customer exists.
  address_in_use: {
    status: 409,
    code: 'validation_error',
    copy: "This number can't be used as a sender.",
  },
} as const satisfies Record<string, { status: number; code: ErrorCode; copy: string }>;
type RefusalReason = keyof typeof SENDER_REFUSALS;

/** Thrown inside the write transaction so a refusal found there rolls back the connection change. */
class SenderRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(reason);
    this.name = 'SenderRefused';
  }
}

/** Thrown inside the sandbox transaction so a live conflict rolls back every earlier change. */
class LiveSenderConflict extends Error {
  constructor(readonly channel: MessagingChannel) {
    super('live sender conflict');
    this.name = 'LiveSenderConflict';
  }
}

const newSandboxAddress = (): string =>
  `${SANDBOX_PREFIX}${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

async function upsertSandbox(
  tx: Tx,
  tenant: Tenant,
  channel: MessagingChannel,
  status: RegistrationStatus,
): Promise<'live_conflict' | 'ok'> {
  const [existing] = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.channel, channel))
    .for('update')
    .limit(1);
  if (existing && existing.provider !== 'fake') return 'live_conflict';
  if (existing) {
    await tx
      .update(channelConnection)
      .set({ registrationStatus: status })
      .where(eq(channelConnection.id, existing.id));
    return 'ok';
  }
  const address = newSandboxAddress();
  const [row] = await tx
    .insert(channelConnection)
    .values({
      organizationId: tenant.orgId,
      channel,
      provider: 'fake',
      address,
      registrationStatus: status,
    })
    .returning();
  if (!row) throw new Error('connection insert returned no row');
  await tx
    .insert(channelRoute)
    .values({
      organizationId: tenant.orgId,
      provider: 'fake',
      channel,
      address,
      connectionId: row.id,
    })
    .onConflictDoNothing({
      target: [channelRoute.provider, channelRoute.channel, channelRoute.address],
    });
  return 'ok';
}

type Resolved =
  | { kind: 'refused'; reason: RefusalReason }
  | { kind: 'resolved'; address: string; credential: ProviderCredentialRow };

/**
 * The saved credential and the normalized address to register (the body's, else the caller id). The
 * address must be an active number of M4's last sync that can send on the channel (ruling AQ).
 */
async function resolveSender(
  tx: Tx,
  channel: MessagingChannel,
  body: z.infer<typeof SenderBody>,
): Promise<Resolved> {
  if (registrationIsSynced(channel) && body.registrationStatus !== undefined) {
    return { kind: 'refused', reason: 'status_synced' };
  }
  if (!registrationIsSynced(channel) && body.registrationStatus === undefined) {
    return { kind: 'refused', reason: 'status_required' };
  }
  const [credential] = await tx
    .select()
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  if (!credential) return { kind: 'refused', reason: 'no_credential' };
  const raw = body.address ?? credential.callerIdE164;
  if (!raw) return { kind: 'refused', reason: 'address_required' };
  const phone = normalizePhone(raw);
  if (!phone.ok) return { kind: 'refused', reason: 'address_invalid' };
  const sendable = sendableFor(await syncedTelnyxNumber(tx, phone.value), channel);
  if (sendable !== 'ok') return { kind: 'refused', reason: sendable };
  return { kind: 'resolved', address: phone.value, credential };
}

/**
 * Asks Telnyx, with the organization's own key, whether the number is in its account (ruling AH).
 * Runs outside any transaction, in every environment. Logs the org id, the HTTP status and the
 * Telnyx error code only: never the key, the number or a response body.
 */
async function verifyOwnership(
  env: Env,
  tenant: Tenant,
  credential: ProviderCredentialRow,
  address: string,
  fetchImpl: typeof fetch | undefined,
): Promise<RefusalReason | null> {
  const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKeyBase64)) return 'not_configured';
  let apiKey: string;
  try {
    apiKey = await openTelnyxKey(credential, masterKeyBase64);
  } catch (error) {
    logger.error('messaging.sender_key_unreadable', {
      orgId: tenant.orgId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return 'credential_unreadable';
  }
  const provider = new TelnyxMessagingProvider({
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  try {
    return (await provider.ownsNumber(address)) ? null : 'not_owned';
  } catch (error) {
    if (!(error instanceof TelnyxMessagingError)) throw error;
    logger.warn('messaging.sender_verify_failed', {
      orgId: tenant.orgId,
      status: error.status,
      code: error.code,
    });
    return error.status === 401 || error.status === 403 ? 'provider_auth' : 'provider_error';
  }
}

/**
 * Ruling AT: a sandbox approval says nothing about Meta, so when a live WhatsApp sender replaces
 * the sandbox one, every approved, unarchived WhatsApp template goes back to pending (the owner
 * marks each approved in Meta again), audited once with the template ids.
 */
async function resetSandboxApprovals(tx: Tx, tenant: Tenant): Promise<void> {
  const reset = await tx
    .update(messageTemplate)
    .set({ approvalStatus: 'pending' })
    .where(
      and(
        eq(messageTemplate.channel, 'whatsapp'),
        eq(messageTemplate.approvalStatus, 'approved'),
        isNull(messageTemplate.archivedAt),
      ),
    )
    .returning({ id: messageTemplate.id });
  if (reset.length === 0) return;
  await insertMessagingAudit(tx, tenant, {
    action: 'template.reset_approval',
    entityType: 'message_template',
    outcome: 'allowed',
    metadata: {
      reason: 'live_sender',
      channel: 'whatsapp',
      templateIds: reset.map((r) => r.id).sort(),
    },
  });
}

/**
 * Writes the channel's telnyx connection and its route, after the ownership check. A sandbox
 * (fake) connection on the channel, or a telnyx connection with another address, is deleted and a
 * fresh one inserted (ruling AJ): the app role may delete connections under RLS, and the FK
 * cascade (run as the table owner) removes the old routes, so the old number stops resolving to
 * this workspace. An unchanged address only updates the registration status, which is always the
 * synced number's (ruling AQ). M4's number lock serializes this with a sync, so a sync cannot
 * deactivate the number between this read and the write. Replacing a sandbox WhatsApp sender
 * resets its sandbox template approvals (ruling AT).
 */
async function writeTelnyxSender(
  tx: Tx,
  tenant: Tenant,
  channel: MessagingChannel,
  address: string,
  requested: RegistrationStatus | undefined,
  verified: ProviderCredentialRow,
): Promise<{ connectionId: string; registrationStatus: RegistrationStatus }> {
  await lockNumbers(tx, tenant.orgId);
  // The key that was checked must still be the saved one: a concurrent reconnect replaces it.
  const [credential] = await tx
    .select({ ciphertext: providerCredential.apiKeyCiphertext })
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .for('share')
    .limit(1);
  if (!credential) throw new SenderRefused('no_credential');
  if (credential.ciphertext !== verified.apiKeyCiphertext) {
    throw new SenderRefused('credential_changed');
  }
  const synced = await syncedTelnyxNumber(tx, address);
  const sendable = sendableFor(synced, channel);
  if (sendable !== 'ok') throw new SenderRefused(sendable);
  if (!synced) throw new SenderRefused('not_synced');
  // SMS: the synced 10DLC state. WhatsApp: the owner's (resolveSender required it).
  const registrationStatus = registrationIsSynced(channel)
    ? smsRegistration(synced)
    : (requested ?? 'pending');

  const [existing] = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.channel, channel))
    .for('update')
    .limit(1);
  let connectionId: string;
  if (existing?.provider === 'telnyx' && existing.address === address) {
    await tx
      .update(channelConnection)
      .set({ registrationStatus })
      .where(eq(channelConnection.id, existing.id));
    connectionId = existing.id;
  } else {
    if (existing) await tx.delete(channelConnection).where(eq(channelConnection.id, existing.id));
    if (existing?.provider === 'fake' && channel === 'whatsapp') {
      await resetSandboxApprovals(tx, tenant);
    }
    const [row] = await tx
      .insert(channelConnection)
      .values({
        organizationId: tenant.orgId,
        channel,
        provider: 'telnyx',
        address,
        registrationStatus,
      })
      .returning({ id: channelConnection.id });
    if (!row) throw new Error('connection insert returned no row');
    connectionId = row.id;
  }

  await tx
    .insert(channelRoute)
    .values({ organizationId: tenant.orgId, provider: 'telnyx', channel, address, connectionId })
    .onConflictDoNothing({
      target: [channelRoute.provider, channelRoute.channel, channelRoute.address],
    });
  // Routes are readable across workspaces (route_lookup), so a number routed elsewhere shows here.
  const [route] = await tx
    .select({ orgId: channelRoute.organizationId })
    .from(channelRoute)
    .where(
      and(
        eq(channelRoute.provider, 'telnyx'),
        eq(channelRoute.channel, channel),
        eq(channelRoute.address, address),
      ),
    )
    .limit(1);
  if (route?.orgId !== tenant.orgId) throw new SenderRefused('address_in_use');
  return { connectionId, registrationStatus };
}

export interface MessagingSendersDeps {
  /** The fetch the Telnyx ownership check uses; tests inject fixtures (no network in tests). */
  fetch?: typeof fetch;
}

/** The senders routes. `deps` is for tests; the app mounts `messagingSenders`. */
export function messagingSendersRoutes(deps: MessagingSendersDeps = {}) {
  return new OpenAPIHono<AppEnv>()
    .openapi(listRoute, async (c) => {
      const { db, tenant } = c.var;
      const items = await withTenant(db, tenant.orgId, (tx) => listSenders(tx, c.env));
      return ok(
        c,
        {
          items,
          sandboxAvailable: adapterFor('fake', c.env) !== null,
          liveAvailable: c.env.PROVIDER === 'telnyx',
        },
        200,
      );
    })
    .openapi(sandboxRoute, async (c) => {
      const { db, tenant } = c.var;
      if (adapterFor('fake', c.env) === null) {
        return fail(c, 404, 'not_found', 'Sandbox is not available.');
      }
      const body = c.req.valid('json');
      try {
        const items = await withTenant(db, tenant.orgId, async (tx) => {
          for (const channel of MESSAGING_CHANNELS) {
            const outcome = await upsertSandbox(tx, tenant, channel, body[channel]);
            if (outcome === 'live_conflict') throw new LiveSenderConflict(channel);
          }
          await insertMessagingAudit(tx, tenant, {
            action: 'sandbox.update',
            entityType: 'channel_connection',
            outcome: 'allowed',
            metadata: { sms: body.sms, whatsapp: body.whatsapp },
          });
          return listSenders(tx, c.env);
        });
        return ok(c, { items }, 200);
      } catch (e) {
        if (!(e instanceof LiveSenderConflict)) throw e;
        await auditMessagingAlone(db, tenant, {
          action: 'sandbox.update',
          entityType: 'channel_connection',
          outcome: 'denied',
          metadata: { reason: 'live_sender', channel: e.channel },
        });
        return fail(c, 422, 'validation_error', 'This channel already has a live sender.');
      }
    })
    .openapi(senderRoute, async (c) => {
      const { db, tenant } = c.var;
      const { channel } = c.req.valid('param');
      const body = c.req.valid('json');
      // States and ids only in the audit: never the number.
      const deny = (reason: RefusalReason | 'role') =>
        auditMessagingAlone(db, tenant, {
          action: 'sender.update',
          entityType: 'channel_connection',
          outcome: 'denied',
          metadata: { reason, channel },
        });
      const refuse = async (reason: RefusalReason) => {
        await deny(reason);
        const refusal = SENDER_REFUSALS[reason];
        return fail(c, refusal.status, refusal.code, refusal.copy);
      };
      if (!canManage(tenant.role)) {
        await deny('role');
        return fail(c, 403, 'forbidden', FORBIDDEN_COPY);
      }
      if (c.env.PROVIDER !== 'telnyx') return refuse('live_unavailable');

      const resolved = await withTenant(db, tenant.orgId, (tx) => resolveSender(tx, channel, body));
      if (resolved.kind === 'refused') return refuse(resolved.reason);
      const { address, credential } = resolved;
      // Before any write: the number must be in the organization's own Telnyx account.
      const unverified = await verifyOwnership(c.env, tenant, credential, address, deps.fetch);
      if (unverified) return refuse(unverified);

      try {
        const items = await withTenant(db, tenant.orgId, async (tx) => {
          const written = await writeTelnyxSender(
            tx,
            tenant,
            channel,
            address,
            body.registrationStatus,
            credential,
          );
          await insertMessagingAudit(tx, tenant, {
            action: 'sender.update',
            entityType: 'channel_connection',
            outcome: 'allowed',
            entityId: written.connectionId,
            metadata: { channel, registrationStatus: written.registrationStatus },
          });
          return listSenders(tx, c.env);
        });
        return ok(c, { items }, 200);
      } catch (e) {
        if (!(e instanceof SenderRefused)) throw e;
        return refuse(e.reason);
      }
    });
}

export const messagingSenders = messagingSendersRoutes();

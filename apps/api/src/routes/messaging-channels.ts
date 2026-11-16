import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  isSmsRegistrationDone,
  type MessagingChannel,
  normalizePhone,
  SMS_ENTITY_TYPES,
  SMS_REGISTRATION_STATES,
  type SmsRegistrationState,
} from '@knoqra/core';
import {
  channelConnection,
  phoneNumber,
  providerCredential,
  type SmsRegistrationRow,
  smsRegistration,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { eq } from 'drizzle-orm';
import type { Env } from '../env';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { publish } from '../lib/realtime';
import { canManage } from '../lib/roles';
import { auditMessagingAlone } from '../messaging/audit';
import { liveEnabled } from '../messaging/senders';
import {
  advanceSmsRegistration,
  type RegistrationDeps,
  resendSmsRegistrationCode,
  SmsRegistrationBody,
  type SmsRegistrationDetails,
  submitSmsRegistration,
  verifySmsRegistrationCode,
} from '../messaging/sms-registration';
import { syncNumbersAndOrders } from '../services/number-purchase';

const CHANNEL_STATES = ['not_enabled', 'pending', 'live', 'rejected'] as const;
type ChannelState = (typeof CHANNEL_STATES)[number];

const RegistrationSchema = z
  .object({
    state: z.enum(SMS_REGISTRATION_STATES),
    entityType: z.enum(SMS_ENTITY_TYPES),
    phone: z.string(),
    brandName: z.string(),
    failureReason: z.string().nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
  })
  .openapi('SmsRegistration');

const ChannelStatusSchema = z
  .object({
    channel: z.enum(['sms', 'whatsapp']),
    state: z.enum(CHANNEL_STATES),
    /** The sending number, when the channel has one. */
    address: z.string().nullable(),
    /** WhatsApp's display name for the number, once Meta shows it. */
    displayName: z.string().nullable(),
    /** One sentence for the Desk, in plain words. */
    detail: z.string(),
    sandbox: z.boolean(),
    /** Whether this person can press Enable here, and if not, why. */
    enable: z.object({
      available: z.boolean(),
      reason: z.enum(['ok', 'not_manager', 'no_connection', 'not_live', 'done']),
    }),
    registration: RegistrationSchema.nullable(),
  })
  .openapi('ChannelStatus');

const ChannelsSchema = z
  .object({ sms: ChannelStatusSchema, whatsapp: ChannelStatusSchema })
  .openapi('MessagingChannels');
type ChannelStatusJson = z.infer<typeof ChannelStatusSchema>;

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const channelsRoute = createRoute({
  method: 'get',
  path: '/api/v1/messaging/channels',
  tags: ['messaging'],
  summary: 'SMS and WhatsApp: not enabled, pending or live, and what Enable can do here',
  security,
  responses: {
    200: { description: 'Channel status', content: json(okEnvelope(ChannelsSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const managerResponses = {
  200: { description: 'Channel status', content: json(okEnvelope(ChannelsSchema)) },
  400: errorResponse('Invalid details'),
  401: errorResponse('No valid session'),
  403: errorResponse('Only owners and admins can enable channels'),
  409: errorResponse('A registration is in progress, or no code is expected'),
  422: errorResponse('Live sending is not available here, or no phone provider is connected'),
  502: errorResponse('The phone provider could not be reached'),
};

const smsRegistrationRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/sms/registration',
  tags: ['messaging'],
  summary: 'Register for US business texting (10DLC) with your own phone provider account',
  security,
  request: { body: { required: true, content: json(SmsRegistrationBody) } },
  responses: managerResponses,
});

const OtpBody = z
  .object({
    pin: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/, 'Enter the code from the text message'),
  })
  .openapi('SmsRegistrationCode');

const smsOtpRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/sms/registration/code',
  tags: ['messaging'],
  summary: "Check the code texted to a sole proprietor's mobile",
  security,
  request: { body: { required: true, content: json(OtpBody) } },
  responses: managerResponses,
});

const smsResendRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/sms/registration/code/resend',
  tags: ['messaging'],
  summary: 'Text the sole proprietor a new code',
  security,
  responses: managerResponses,
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/api/v1/messaging/channels/refresh',
  tags: ['messaging'],
  summary: 'Check SMS and WhatsApp status with the phone provider now (sync, registration)',
  security,
  responses: managerResponses,
});

const REGISTRATION_DETAIL: Record<SmsRegistrationState, string> = {
  submitting: 'Sending your registration.',
  otp_required: 'Enter the code we texted to your mobile to verify it is yours.',
  brand_pending:
    'Your business is being verified. This usually takes minutes, sometimes a few days.',
  campaign_pending:
    'Carriers are reviewing how you will text customers. This usually takes 1 to 3 business days.',
  number_pending: 'Your number is being added to the approved registration.',
  approved: 'Registered for US business texting.',
  rejected: 'The registration was not approved.',
  failed: 'The registration needs a fix before it can continue.',
};

interface Facts {
  hasCredential: boolean;
  senders: Map<MessagingChannel, typeof channelConnection.$inferSelect>;
  displayNames: Map<string, string | null>;
  registration: SmsRegistrationRow | undefined;
}

async function loadFacts(tx: Tx): Promise<Facts> {
  const [credential] = await tx
    .select({ id: providerCredential.id })
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  const senders = await tx.select().from(channelConnection);
  const numbers = await tx
    .select({ e164: phoneNumber.e164, displayName: phoneNumber.whatsappDisplayName })
    .from(phoneNumber);
  const [registration] = await tx.select().from(smsRegistration).limit(1);
  return {
    hasCredential: credential !== undefined,
    senders: new Map(senders.map((s) => [s.channel, s] as const)),
    displayNames: new Map(numbers.map((n) => [n.e164, n.displayName] as const)),
    registration,
  };
}

/** One channel's status for the Desk, from its sender and (SMS) its registration. */
export function channelStatus(
  channel: MessagingChannel,
  facts: Facts,
  env: Env,
  role: string,
): ChannelStatusJson {
  const sender = facts.senders.get(channel);
  const registration = channel === 'sms' ? facts.registration : undefined;
  const live = sender ? liveEnabled(sender.provider, channel, env, facts.hasCredential) : false;
  const regInFlight = registration !== undefined && !isSmsRegistrationDone(registration.state);
  let state: ChannelState;
  if (sender && live && sender.registrationStatus === 'approved') state = 'live';
  else if (sender?.registrationStatus === 'rejected' || registration?.state === 'rejected')
    state = 'rejected';
  else if (
    sender?.registrationStatus === 'pending' ||
    regInFlight ||
    registration?.state === 'approved'
  )
    state = 'pending';
  else state = 'not_enabled';

  const name = channel === 'sms' ? 'SMS' : 'WhatsApp';
  let detail: string;
  if (state === 'live') {
    detail =
      sender?.provider === 'fake'
        ? `${name} sandbox: nothing reaches a real phone.`
        : `${name} sends from ${sender?.address}.`;
  } else if (registration && (regInFlight || registration.state === 'rejected')) {
    detail = registration.failureReason
      ? `${REGISTRATION_DETAIL[registration.state]} ${registration.failureReason}`
      : REGISTRATION_DETAIL[registration.state];
  } else if (state === 'pending') {
    detail =
      channel === 'whatsapp'
        ? 'Meta is reviewing your WhatsApp Business account. Messages send once it is approved.'
        : 'Your US texting registration is being reviewed. Replies still arrive.';
  } else if (state === 'rejected') {
    detail =
      channel === 'whatsapp'
        ? 'Meta did not approve this WhatsApp number. Check your WhatsApp Business account.'
        : 'The US texting registration was not approved.';
  } else {
    detail =
      channel === 'whatsapp'
        ? 'Connect a WhatsApp Business number to send and receive WhatsApp here.'
        : 'Register for US business texting to send SMS. Replies still arrive.';
  }

  const manager = canManage(role);
  const reason = !manager
    ? 'not_manager'
    : env.PROVIDER !== 'telnyx'
      ? 'not_live'
      : !facts.hasCredential
        ? 'no_connection'
        : state === 'live' || (channel === 'sms' && regInFlight)
          ? 'done'
          : 'ok';
  const registrationJson = registration
    ? {
        state: registration.state,
        entityType: registration.entityType,
        phone: registration.phoneE164,
        brandName: (registration.details as SmsRegistrationDetails).brandName,
        failureReason: registration.failureReason,
        lastCheckedAt: registration.lastCheckedAt ? registration.lastCheckedAt.toISOString() : null,
      }
    : null;
  return {
    channel,
    state,
    address: sender && sender.provider !== 'fake' ? sender.address : null,
    displayName: sender ? (facts.displayNames.get(sender.address) ?? null) : null,
    detail,
    sandbox: sender?.provider === 'fake',
    enable: { available: reason === 'ok', reason },
    registration: registrationJson,
  };
}

async function channelsOf(c: { env: Env; var: AppEnv['Variables'] }) {
  const { db, tenant } = c.var;
  const facts = await withTenant(db, tenant.orgId, loadFacts);
  return {
    sms: channelStatus('sms', facts, c.env, tenant.role),
    whatsapp: channelStatus('whatsapp', facts, c.env, tenant.role),
  };
}

const FORBIDDEN = 'Only owners and admins can enable channels.';

/** The channel routes. `deps` is for tests (fixtures instead of the network). */
export function messagingChannelsRoutes(deps: RegistrationDeps = {}) {
  return new OpenAPIHono<AppEnv>()
    .openapi(channelsRoute, async (c) => ok(c, await channelsOf(c), 200))
    .openapi(smsRegistrationRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      if (c.env.PROVIDER !== 'telnyx') {
        return fail(c, 422, 'not_configured', "Live sending isn't available on this deployment.");
      }
      const details = c.req.valid('json');
      const credential = await withTenant(db, tenant.orgId, async (tx) => {
        const [row] = await tx
          .select({ callerId: providerCredential.callerIdE164 })
          .from(providerCredential)
          .where(eq(providerCredential.provider, 'telnyx'))
          .limit(1);
        return row;
      });
      if (!credential)
        return fail(c, 422, 'validation_error', 'Connect your phone provider first.');
      const phone = normalizePhone(details.phone ?? credential.callerId ?? '');
      if (!phone.ok)
        return fail(c, 400, 'validation_error', 'phone: Choose the number to register.');
      try {
        const result = await submitSmsRegistration(db, c.env, tenant, details, phone.value, deps);
        if (result.kind === 'error') {
          return fail(
            c,
            result.status,
            result.status === 409 ? 'invalid_state' : 'validation_error',
            result.message,
          );
        }
      } catch (error) {
        logger.error('messaging.sms_registration_failed', { orgId: tenant.orgId, error });
        return fail(
          c,
          502,
          'provider_unavailable',
          'Your phone provider could not be reached. Try again in a moment.',
        );
      }
      await publish(c.env, tenant.orgId, { type: 'channels.updated', data: {} });
      return ok(c, await channelsOf(c), 200);
    })
    .openapi(smsOtpRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      const result = await verifySmsRegistrationCode(
        db,
        c.env,
        tenant,
        c.req.valid('json').pin,
        deps,
      );
      if (result.kind === 'error') {
        return fail(
          c,
          result.status,
          result.status === 409 ? 'invalid_state' : 'validation_error',
          result.message,
        );
      }
      return ok(c, await channelsOf(c), 200);
    })
    .openapi(smsResendRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      const result = await resendSmsRegistrationCode(db, c.env, tenant, deps);
      if (result.kind === 'error') {
        return fail(
          c,
          result.status,
          result.status === 409 ? 'invalid_state' : 'validation_error',
          result.message,
        );
      }
      return ok(c, await channelsOf(c), 200);
    })
    .openapi(refreshRoute, async (c) => {
      const { db, tenant } = c.var;
      if (!canManage(tenant.role)) return fail(c, 403, 'forbidden', FORBIDDEN);
      if (c.env.PROVIDER !== 'telnyx') {
        return fail(c, 422, 'not_configured', "Live sending isn't available on this deployment.");
      }
      try {
        await advanceSmsRegistration(db, c.env, tenant.orgId, deps);
        await syncNumbersAndOrders(db, c.env, tenant.orgId, tenant, deps);
      } catch (error) {
        logger.warn('messaging.channels_refresh_failed', {
          orgId: tenant.orgId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return fail(
          c,
          502,
          'provider_unavailable',
          'Your phone provider could not be reached. Try again in a moment.',
        );
      }
      await auditMessagingAlone(db, tenant, {
        action: 'whatsapp.sync',
        entityType: 'channel_connection',
        outcome: 'allowed',
      });
      await publish(c.env, tenant.orgId, { type: 'channels.updated', data: {} });
      return ok(c, await channelsOf(c), 200);
    });
}

export const messagingChannels = messagingChannelsRoutes();

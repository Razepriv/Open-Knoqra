import { z } from '@hono/zod-openapi';
import {
  COMPLIANCE_TEXT_MAX,
  complianceTextProblem,
  isSmsRegistrationDone,
  normalizePhone,
  SMS_ENTITY_TYPES,
  type SmsComplianceTexts,
  type SmsEntityType,
  type SmsRegistrationState,
} from '@knoqra/core';
import { type Database, type SmsRegistrationRow, smsRegistration, withTenant } from '@knoqra/db';
import {
  assignmentPhase,
  brandPhase,
  campaignPhase,
  TelnyxApiError,
  TelnyxTenDlcClient,
  type TenDlcBrandRequest,
  type TenDlcEntityType,
} from '@knoqra/providers';
import { eq } from 'drizzle-orm';
import { apiOrigin } from '../connectors/registry';
import type { Env } from '../env';
import type { Tenant } from '../lib/context';
import { logger } from '../lib/logger';
import { insertMessagingAudit } from './audit';
import { telnyxApiKey } from './senders';

/** The messaging profile KNOQRA puts registered numbers on, when a number has none. */
export const MESSAGING_PROFILE_NAME = 'KNOQRA messaging';

/** Use cases a business can register (no sub-use-cases needed); sole proprietors have their own. */
export const SMS_USECASES = [
  'CUSTOMER_CARE',
  'ACCOUNT_NOTIFICATION',
  'DELIVERY_NOTIFICATION',
  'MARKETING',
] as const;

/** Registry verticals (Telnyx's `CreateBrand.vertical` enum). */
export const SMS_VERTICALS = [
  'AGRICULTURE',
  'COMMUNICATION',
  'CONSTRUCTION',
  'EDUCATION',
  'ENERGY',
  'ENTERTAINMENT',
  'FINANCIAL',
  'GOVERNMENT',
  'HEALTHCARE',
  'HOSPITALITY',
  'HUMAN_RESOURCES',
  'INSURANCE',
  'LEGAL',
  'MANUFACTURING',
  'NGO',
  'PROFESSIONAL',
  'REAL_ESTATE',
  'RETAIL',
  'TECHNOLOGY',
  'TRANSPORTATION',
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const complianceText = z
  .string()
  .trim()
  .min(1)
  .max(COMPLIANCE_TEXT_MAX * 13);

export const SmsRegistrationBody = z
  .object({
    entityType: z.enum(SMS_ENTITY_TYPES),
    /** The number to register, E.164; defaults to the caller id. */
    phone: z.string().min(1).max(32).optional(),
    brandName: text(100),
    /** Business legal name (not for sole proprietors). */
    legalName: z.string().trim().max(100).optional(),
    /** US EIN, `XX-XXXXXXX` (not for sole proprietors). */
    ein: z.string().trim().max(20).optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    email: z.email().max(100),
    /** The business phone (a sole proprietor's mobile, which receives a code). */
    contactPhone: z.string().min(1).max(32),
    street: text(100),
    city: text(100),
    state: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'Use the two-letter state code'),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'Use a five-digit ZIP code'),
    website: z.string().trim().max(100).optional(),
    vertical: z.enum(SMS_VERTICALS),
    usecase: z.enum(SMS_USECASES).optional(),
    stockSymbol: z.string().trim().max(10).optional(),
    stockExchange: z.string().trim().max(10).optional(),
    messageFlow: complianceText,
    description: complianceText,
    optinMessage: complianceText,
    helpMessage: complianceText,
    optoutMessage: complianceText,
    sample1: complianceText,
    sample2: complianceText,
  })
  .openapi('SmsRegistrationRequest');
export type SmsRegistrationDetails = z.infer<typeof SmsRegistrationBody>;

const TEXT_FIELDS = [
  'messageFlow',
  'description',
  'optinMessage',
  'helpMessage',
  'optoutMessage',
  'sample1',
  'sample2',
] as const satisfies readonly (keyof SmsComplianceTexts)[];

/** The first problem with the submitted details, as `field: message`, or null. */
export function detailsProblem(details: SmsRegistrationDetails): string | null {
  const sole = details.entityType === 'sole_proprietor';
  if (sole && (!details.firstName || !details.lastName))
    return 'firstName: Enter your first and last name.';
  if (!sole && !details.legalName) return 'legalName: Enter the legal business name.';
  if (!sole && !/^\d{2}-?\d{7}$/.test(details.ein ?? ''))
    return 'ein: Enter the EIN as XX-XXXXXXX.';
  if (details.entityType === 'public_profit' && (!details.stockSymbol || !details.stockExchange)) {
    return 'stockSymbol: Public companies need a stock symbol and exchange.';
  }
  if (!normalizePhone(details.contactPhone).ok) return 'contactPhone: Enter a valid phone number.';
  for (const field of TEXT_FIELDS) {
    const problem = complianceTextProblem(field, details[field], details.brandName);
    if (problem) return `${field}: ${problem}`;
  }
  return null;
}

const ENTITY: Record<SmsEntityType, TenDlcEntityType> = {
  sole_proprietor: 'SOLE_PROPRIETOR',
  private_profit: 'PRIVATE_PROFIT',
  public_profit: 'PUBLIC_PROFIT',
  non_profit: 'NON_PROFIT',
};

/** The registry brand request for the details. */
export function brandRequest(
  details: SmsRegistrationDetails,
  webhookUrl: string | null,
): TenDlcBrandRequest {
  const phone = normalizePhone(details.contactPhone);
  const contact = phone.ok ? phone.value : details.contactPhone;
  const common = {
    entityType: ENTITY[details.entityType],
    displayName: details.brandName,
    email: details.email,
    phone: contact,
    street: details.street,
    city: details.city,
    state: details.state.toUpperCase(),
    postalCode: details.postalCode,
    country: 'US',
    vertical: details.vertical,
    ...(details.website ? { website: details.website } : {}),
    ...(webhookUrl ? { webhookURL: webhookUrl } : {}),
  };
  if (details.entityType === 'sole_proprietor') {
    return {
      ...common,
      firstName: details.firstName,
      lastName: details.lastName,
      mobilePhone: contact,
    };
  }
  return {
    ...common,
    companyName: details.legalName,
    ein: details.ein?.replace(/^(\d{2})-?(\d{7})$/, '$1-$2'),
    ...(details.entityType === 'public_profit'
      ? {
          stockSymbol: details.stockSymbol,
          stockExchange: details.stockExchange?.toUpperCase(),
          businessContactEmail: details.email,
        }
      : {}),
  };
}

type Advance = Partial<
  Pick<
    SmsRegistrationRow,
    | 'state'
    | 'messagingProfileId'
    | 'brandId'
    | 'brandStatus'
    | 'campaignId'
    | 'campaignStatus'
    | 'assignmentStatus'
    | 'failureReason'
  >
>;

/** Plain words for a provider refusal: the status and code, never a body. */
const refusalReason = (error: TelnyxApiError): string =>
  `Your phone provider refused this step (status ${error.status}, code ${error.code}).`;

/** A server-side or network problem: retried on the next check, not a failure. */
const isTransient = (error: unknown): boolean =>
  error instanceof TelnyxApiError &&
  (error.status === 0 || error.status >= 500 || error.status === 429);

/**
 * One step of the registration from its current state. Each step is idempotent through the ids it
 * stores, so a retry never registers twice: the campaign's `referenceId` is the registration id,
 * which the registry refuses to reuse.
 */
async function step(
  row: SmsRegistrationRow,
  client: TelnyxTenDlcClient,
  env: Env,
): Promise<Advance> {
  const details = row.details as SmsRegistrationDetails;
  const webhook = apiOrigin(env) ? `${apiOrigin(env)}/webhooks/telnyx` : null;
  switch (row.state) {
    case 'submitting':
    case 'failed': {
      const number = await client.findNumber(row.phoneE164);
      if (!number) {
        return {
          state: 'failed',
          failureReason: "This number isn't on your phone provider account.",
        };
      }
      let profileId = number.messagingProfileId ?? row.messagingProfileId;
      if (!profileId) {
        profileId = await client.ensureMessagingProfile(MESSAGING_PROFILE_NAME, webhook);
        await client.setNumberProfile(number.id, profileId);
      }
      if (row.brandId)
        return { state: 'brand_pending', messagingProfileId: profileId, failureReason: null };
      const brand = await client.createBrand(brandRequest(details, null));
      const advance: Advance = {
        messagingProfileId: profileId,
        brandId: brand.brandId,
        brandStatus: brand.identityStatus ?? brand.status,
        failureReason: null,
      };
      if (row.entityType === 'sole_proprietor') {
        await client.sendBrandOtp(
          brand.brandId,
          `${details.brandName}: Your verification code is @OTP_PIN@`,
          `${details.brandName}: Your number is verified for business texting.`,
        );
        return { ...advance, state: 'otp_required' };
      }
      return { ...advance, state: 'brand_pending' };
    }
    case 'brand_pending': {
      if (!row.brandId)
        return {
          state: 'failed',
          failureReason: 'The registration lost its brand. Submit it again.',
        };
      const brand = await client.getBrand(row.brandId);
      const phase = brandPhase(brand);
      const brandStatus = brand.identityStatus ?? brand.status;
      if (phase === 'rejected') {
        return {
          state: 'rejected',
          brandStatus,
          failureReason: brand.failureReason ?? 'The registry could not verify this business.',
        };
      }
      if (phase === 'pending') return { brandStatus };
      const campaign = await client.createCampaign({
        brandId: row.brandId,
        usecase:
          row.entityType === 'sole_proprietor'
            ? 'SOLE_PROPRIETOR'
            : (details.usecase ?? 'CUSTOMER_CARE'),
        description: details.description,
        messageFlow: details.messageFlow,
        sample1: details.sample1,
        sample2: details.sample2,
        helpMessage: details.helpMessage,
        optinMessage: details.optinMessage,
        optoutMessage: details.optoutMessage,
        helpKeywords: 'HELP,INFO',
        optinKeywords: 'START,YES',
        optoutKeywords: 'STOP,UNSUBSCRIBE,CANCEL,END,QUIT',
        subscriberHelp: true,
        subscriberOptin: true,
        subscriberOptout: true,
        embeddedLink: false,
        embeddedPhone: false,
        numberPool: false,
        ageGated: false,
        directLending: false,
        termsAndConditions: true,
        referenceId: row.id,
      });
      return {
        state: 'campaign_pending',
        brandStatus,
        campaignId: campaign.campaignId,
        campaignStatus: campaign.campaignStatus,
        failureReason: null,
      };
    }
    case 'campaign_pending': {
      if (!row.campaignId) return { state: 'brand_pending' };
      const campaign = await client.getCampaign(row.campaignId);
      const phase = campaignPhase(campaign.campaignStatus);
      if (phase === 'rejected') {
        return {
          state: 'rejected',
          campaignStatus: campaign.campaignStatus,
          failureReason: campaign.failureReason ?? 'Carriers did not approve the texting campaign.',
        };
      }
      if (phase === 'pending') return { campaignStatus: campaign.campaignStatus };
      const existing = await client.getAssignment(row.phoneE164);
      const assignment =
        existing && existing.campaignId === row.campaignId
          ? existing
          : await client.assignNumber(row.phoneE164, row.campaignId);
      return {
        state:
          assignmentPhase(assignment.assignmentStatus) === 'assigned'
            ? 'approved'
            : 'number_pending',
        campaignStatus: campaign.campaignStatus,
        assignmentStatus: assignment.assignmentStatus,
      };
    }
    case 'number_pending': {
      const assignment = await client.getAssignment(row.phoneE164);
      const phase = assignmentPhase(assignment?.assignmentStatus ?? null);
      if (phase === 'assigned')
        return { state: 'approved', assignmentStatus: assignment?.assignmentStatus ?? null };
      if (phase === 'failed') {
        return {
          state: 'failed',
          assignmentStatus: assignment?.assignmentStatus ?? null,
          failureReason:
            assignment?.failureReason ?? 'The number could not be added to the campaign.',
        };
      }
      return { assignmentStatus: assignment?.assignmentStatus ?? null };
    }
    default:
      return {};
  }
}

export interface RegistrationDeps {
  fetch?: typeof fetch;
}

async function clientFor(db: Database, env: Env, orgId: string, deps: RegistrationDeps) {
  const apiKey = await withTenant(db, orgId, (tx) => telnyxApiKey(tx, env));
  return apiKey
    ? new TelnyxTenDlcClient({ apiKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
    : null;
}

async function save(
  db: Database,
  orgId: string,
  id: string,
  changes: Advance & { lastCheckedAt?: Date },
) {
  await withTenant(db, orgId, (tx) =>
    tx.update(smsRegistration).set(changes).where(eq(smsRegistration.id, id)),
  );
}

/**
 * Moves the organization's registration as far as it can go now: up to three steps (submit, then a
 * campaign once the brand is verified, then the number once the campaign is approved). Provider
 * refusals are kept as the failure reason; outages leave the state for the next check. Returns the
 * registration as it stands, or null when there is none.
 */
export async function advanceSmsRegistration(
  db: Database,
  env: Env,
  orgId: string,
  deps: RegistrationDeps = {},
): Promise<SmsRegistrationRow | null> {
  const load = () =>
    withTenant(db, orgId, async (tx) => {
      const [row] = await tx.select().from(smsRegistration).limit(1);
      return row ?? null;
    });
  let row = await load();
  if (!row || isSmsRegistrationDone(row.state) || row.state === 'otp_required') return row;
  const client = await clientFor(db, env, orgId, deps);
  if (!client) return row;
  for (
    let i = 0;
    i < 4 && row && !isSmsRegistrationDone(row.state) && row.state !== 'otp_required';
    i++
  ) {
    const before: SmsRegistrationState = row.state;
    let changes: Advance;
    try {
      changes = await step(row, client, env);
    } catch (error) {
      if (!(error instanceof TelnyxApiError)) throw error;
      logger.warn('messaging.sms_registration_step_failed', {
        orgId,
        state: row.state,
        status: error.status,
        code: error.code,
      });
      if (isTransient(error)) {
        await save(db, orgId, row.id, { lastCheckedAt: new Date() });
        return load();
      }
      // A refusal at submission is a failure to fix; later, the reason is kept and the step retried.
      changes =
        row.state === 'submitting' || row.state === 'failed'
          ? { state: 'failed', failureReason: refusalReason(error) }
          : { failureReason: refusalReason(error) };
    }
    await save(db, orgId, row.id, { ...changes, lastCheckedAt: new Date() });
    row = await load();
    if (!row || row.state === before) break;
  }
  return row;
}

export type SubmitResult =
  | { kind: 'ok'; registration: SmsRegistrationRow | null }
  | { kind: 'error'; status: 400 | 409 | 422; message: string };

/**
 * Starts (or, after a failure or rejection, restarts) the workspace's registration with these
 * details and runs the first steps now. A registration in progress or approved is not replaced.
 */
export async function submitSmsRegistration(
  db: Database,
  env: Env,
  tenant: Tenant,
  details: SmsRegistrationDetails,
  phoneE164: string,
  deps: RegistrationDeps = {},
): Promise<SubmitResult> {
  const problem = detailsProblem(details);
  if (problem) return { kind: 'error', status: 400, message: problem };
  const stored = await withTenant(db, tenant.orgId, async (tx) => {
    const [existing] = await tx.select().from(smsRegistration).limit(1).for('update');
    if (existing && existing.state !== 'failed' && existing.state !== 'rejected')
      return 'busy' as const;
    const values = {
      provider: 'telnyx' as const,
      entityType: details.entityType,
      phoneE164,
      details,
      state: 'submitting' as const,
      createdBy: tenant.userId,
      failureReason: null,
    };
    if (existing) {
      // A rejected brand is not reused; a failed submission keeps its profile and brand ids.
      await tx
        .update(smsRegistration)
        .set({
          ...values,
          ...(existing.state === 'rejected'
            ? {
                brandId: null,
                brandStatus: null,
                campaignId: null,
                campaignStatus: null,
                assignmentStatus: null,
              }
            : {}),
        })
        .where(eq(smsRegistration.id, existing.id));
    } else {
      await tx.insert(smsRegistration).values({ organizationId: tenant.orgId, ...values });
    }
    await insertMessagingAudit(tx, tenant, {
      action: 'sms_registration.submit',
      entityType: 'sms_registration',
      outcome: 'allowed',
      metadata: { entityType: details.entityType },
    });
    return 'stored' as const;
  });
  if (stored === 'busy') {
    return { kind: 'error', status: 409, message: 'A registration is already in progress.' };
  }
  return { kind: 'ok', registration: await advanceSmsRegistration(db, env, tenant.orgId, deps) };
}

/** Checks the sole proprietor's code; on success the registration moves on at once. */
export async function verifySmsRegistrationCode(
  db: Database,
  env: Env,
  tenant: Tenant,
  pin: string,
  deps: RegistrationDeps = {},
): Promise<SubmitResult> {
  const row = await withTenant(db, tenant.orgId, async (tx) => {
    const [found] = await tx.select().from(smsRegistration).limit(1);
    return found;
  });
  if (row?.state !== 'otp_required' || !row.brandId) {
    return { kind: 'error', status: 409, message: 'No code is expected right now.' };
  }
  const client = await clientFor(db, env, tenant.orgId, deps);
  if (!client) return { kind: 'error', status: 422, message: 'Connect your phone provider first.' };
  try {
    await client.verifyBrandOtp(row.brandId, pin);
  } catch (error) {
    if (error instanceof TelnyxApiError && error.status >= 400 && error.status < 500) {
      return {
        kind: 'error',
        status: 422,
        message: 'That code is wrong or expired. Check it, or send a new one.',
      };
    }
    throw error;
  }
  await withTenant(db, tenant.orgId, async (tx) => {
    await tx
      .update(smsRegistration)
      .set({ state: 'brand_pending', failureReason: null })
      .where(eq(smsRegistration.id, row.id));
    await insertMessagingAudit(tx, tenant, {
      action: 'sms_registration.otp',
      entityType: 'sms_registration',
      outcome: 'allowed',
    });
  });
  return { kind: 'ok', registration: await advanceSmsRegistration(db, env, tenant.orgId, deps) };
}

/** Texts the sole proprietor a new code. */
export async function resendSmsRegistrationCode(
  db: Database,
  env: Env,
  tenant: Tenant,
  deps: RegistrationDeps = {},
): Promise<SubmitResult> {
  const row = await withTenant(db, tenant.orgId, async (tx) => {
    const [found] = await tx.select().from(smsRegistration).limit(1);
    return found;
  });
  if (row?.state !== 'otp_required' || !row.brandId) {
    return { kind: 'error', status: 409, message: 'No code is expected right now.' };
  }
  const client = await clientFor(db, env, tenant.orgId, deps);
  if (!client) return { kind: 'error', status: 422, message: 'Connect your phone provider first.' };
  const details = row.details as SmsRegistrationDetails;
  await client.sendBrandOtp(
    row.brandId,
    `${details.brandName}: Your verification code is @OTP_PIN@`,
    `${details.brandName}: Your number is verified for business texting.`,
  );
  return { kind: 'ok', registration: row };
}

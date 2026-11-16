import { z } from 'zod';
import { TelnyxApiError } from './errors';

/**
 * Telnyx's US 10DLC registration API, as its OpenAPI document (team-telnyx/openapi spec3.json,
 * 2026-11-12) describes it. 10DLC responses are not wrapped in `data`; messaging profile and phone
 * number responses are, so every read takes `body.data ?? body`. Errors carry the HTTP status and a
 * sanitized code only, never a body (bodies echo submitted details).
 */
const DEFAULT_API_BASE = 'https://api.telnyx.com/v2';
const DEFAULT_TIMEOUT_MS = 20_000;
const SAFE_CODE = /^[\w.-]{1,40}$/;

export type TenDlcEntityType =
  | 'SOLE_PROPRIETOR'
  | 'PRIVATE_PROFIT'
  | 'PUBLIC_PROFIT'
  | 'NON_PROFIT';

/** `POST /10dlc/brand` (schema `CreateBrand`); undefined fields are left out of the request. */
export interface TenDlcBrandRequest {
  entityType: TenDlcEntityType;
  displayName: string;
  companyName?: string;
  firstName?: string;
  lastName?: string;
  ein?: string;
  phone?: string;
  mobilePhone?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country: string;
  email: string;
  website?: string;
  vertical: string;
  stockSymbol?: string;
  stockExchange?: string;
  businessContactEmail?: string;
  webhookURL?: string;
}

/** `POST /10dlc/campaignBuilder` (schema `CampaignRequest`). */
export interface TenDlcCampaignRequest {
  brandId: string;
  usecase: string;
  description: string;
  messageFlow: string;
  sample1: string;
  sample2: string;
  helpMessage: string;
  optinMessage: string;
  optoutMessage: string;
  helpKeywords: string;
  optinKeywords: string;
  optoutKeywords: string;
  subscriberHelp: boolean;
  subscriberOptin: boolean;
  subscriberOptout: boolean;
  embeddedLink: boolean;
  embeddedPhone: boolean;
  numberPool: boolean;
  ageGated: boolean;
  directLending: boolean;
  termsAndConditions: boolean;
  /** Unique per campaign: Telnyx refuses a second campaign with the same one (idempotency). */
  referenceId: string;
  webhookURL?: string;
}

const brandSchema = z.object({
  brandId: z.string().min(1),
  identityStatus: z.string().nullish(),
  status: z.string().nullish(),
  failureReasons: z.union([z.string(), z.array(z.unknown())]).nullish(),
});
export interface TenDlcBrand {
  brandId: string;
  /** VERIFIED, UNVERIFIED, SELF_DECLARED or VETTED_VERIFIED (unknown values are kept as given). */
  identityStatus: string | null;
  /** OK, REGISTRATION_PENDING or REGISTRATION_FAILED. */
  status: string | null;
  failureReason: string | null;
}

const campaignSchema = z.object({
  campaignId: z.string().min(1),
  campaignStatus: z.string().nullish(),
  submissionStatus: z.string().nullish(),
  failureReasons: z.union([z.string(), z.array(z.unknown())]).nullish(),
});
export interface TenDlcCampaign {
  campaignId: string;
  /** TCR_PENDING ... MNO_PROVISIONED (the number can send) or a failure. */
  campaignStatus: string | null;
  failureReason: string | null;
}

const assignmentSchema = z.object({
  phoneNumber: z.string().min(1),
  campaignId: z.string().nullish(),
  assignmentStatus: z.string().nullish(),
  failureReasons: z.union([z.string(), z.array(z.unknown())]).nullish(),
});
export interface TenDlcAssignment {
  phoneNumber: string;
  campaignId: string | null;
  /** PENDING_ASSIGNMENT, ASSIGNED, FAILED_ASSIGNMENT, ... */
  assignmentStatus: string | null;
  failureReason: string | null;
}

const profilesSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string().nullish() })),
});
const profileSchema = z.object({ data: z.object({ id: z.string().min(1) }) });
const numberLookupSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      phone_number: z.string(),
      messaging_profile_id: z.string().nullish(),
    }),
  ),
});

const errorSchema = z.object({
  errors: z.array(z.object({ code: z.union([z.string(), z.number()]) })).min(1),
});

/** Telnyx's failure reasons can be a string or a list; keep a short, plain summary. */
function reasonOf(value: string | unknown[] | null | undefined): string | null {
  if (value == null) return null;
  const text =
    typeof value === 'string'
      ? value
      : value
          .map((v) =>
            typeof v === 'string'
              ? v
              : typeof v === 'object' && v !== null && 'description' in v
                ? String((v as { description: unknown }).description)
                : '',
          )
          .filter(Boolean)
          .join('; ');
  const trimmed = text.trim().slice(0, 300);
  return trimmed.length > 0 ? trimmed : null;
}

const unwrap = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'data' in body
    ? (body as { data: unknown }).data
    : body;

export interface TelnyxTenDlcOptions {
  apiKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

/** The 10DLC steps KNOQRA runs with a workspace's own Telnyx key. */
export class TelnyxTenDlcClient {
  readonly #apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(opts: TelnyxTenDlcOptions) {
    this.#apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The profile named `name`, created (with this webhook) when the account has none. */
  async ensureMessagingProfile(name: string, webhookUrl: string | null): Promise<string> {
    const found = profilesSchema.safeParse(
      await this.request(
        'GET',
        `/messaging_profiles?${new URLSearchParams({ 'filter[name][eq]': name })}`,
      ),
    );
    const existing = found.success ? found.data.data.find((p) => p.name === name) : undefined;
    if (existing) return existing.id;
    const created = profileSchema.safeParse(
      await this.request('POST', '/messaging_profiles', {
        name,
        whitelisted_destinations: ['US'],
        ...(webhookUrl ? { webhook_url: webhookUrl, webhook_api_version: '2' } : {}),
      }),
    );
    if (!created.success) throw new TelnyxApiError(200, 'invalid_response');
    return created.data.data.id;
  }

  /** The account's number resource for an E.164 number, or null when it is not on the account. */
  async findNumber(
    e164: string,
  ): Promise<{ id: string; messagingProfileId: string | null } | null> {
    const parsed = numberLookupSchema.safeParse(
      await this.request(
        'GET',
        `/phone_numbers?${new URLSearchParams({ 'filter[phone_number]': e164.replace(/^\+/, '') })}`,
      ),
    );
    if (!parsed.success) throw new TelnyxApiError(200, 'invalid_response');
    const row = parsed.data.data.find((n) => n.phone_number === e164);
    return row ? { id: row.id, messagingProfileId: row.messaging_profile_id ?? null } : null;
  }

  /** `PATCH /phone_numbers/{id}/messaging`: puts the number on the profile (needed for 10DLC). */
  async setNumberProfile(numberId: string, profileId: string): Promise<void> {
    await this.request('PATCH', `/phone_numbers/${encodeURIComponent(numberId)}/messaging`, {
      messaging_profile_id: profileId,
    });
  }

  async createBrand(input: TenDlcBrandRequest): Promise<TenDlcBrand> {
    const body = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined && v !== ''),
    );
    return this.brandOf(await this.request('POST', '/10dlc/brand', body));
  }

  async getBrand(brandId: string): Promise<TenDlcBrand> {
    return this.brandOf(await this.request('GET', `/10dlc/brand/${encodeURIComponent(brandId)}`));
  }

  /** Texts the sole proprietor's mobile a code (`pinSms` must contain `@OTP_PIN@`). */
  async sendBrandOtp(brandId: string, pinSms: string, successSms: string): Promise<void> {
    await this.request('POST', `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, {
      pinSms,
      successSms,
    });
  }

  /** Checks the code; Telnyx answers 204 on success and 400 for a wrong or expired code. */
  async verifyBrandOtp(brandId: string, otpPin: string): Promise<void> {
    await this.request('PUT', `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`, { otpPin });
  }

  async createCampaign(input: TenDlcCampaignRequest): Promise<TenDlcCampaign> {
    return this.campaignOf(await this.request('POST', '/10dlc/campaignBuilder', input));
  }

  async getCampaign(campaignId: string): Promise<TenDlcCampaign> {
    return this.campaignOf(
      await this.request('GET', `/10dlc/campaign/${encodeURIComponent(campaignId)}`),
    );
  }

  async assignNumber(phoneNumber: string, campaignId: string): Promise<TenDlcAssignment> {
    return this.assignmentOf(
      await this.request('POST', '/10dlc/phone_number_campaigns', { phoneNumber, campaignId }),
    );
  }

  /** The number's campaign assignment, or null when it has none (404). */
  async getAssignment(phoneNumber: string): Promise<TenDlcAssignment | null> {
    try {
      return this.assignmentOf(
        await this.request(
          'GET',
          `/10dlc/phone_number_campaigns/${encodeURIComponent(phoneNumber)}`,
        ),
      );
    } catch (error) {
      if (error instanceof TelnyxApiError && error.status === 404) return null;
      throw error;
    }
  }

  private brandOf(body: unknown): TenDlcBrand {
    const parsed = brandSchema.safeParse(unwrap(body));
    if (!parsed.success) throw new TelnyxApiError(200, 'invalid_response');
    return {
      brandId: parsed.data.brandId,
      identityStatus: parsed.data.identityStatus ?? null,
      status: parsed.data.status ?? null,
      failureReason: reasonOf(parsed.data.failureReasons),
    };
  }

  private campaignOf(body: unknown): TenDlcCampaign {
    const parsed = campaignSchema.safeParse(unwrap(body));
    if (!parsed.success) throw new TelnyxApiError(200, 'invalid_response');
    return {
      campaignId: parsed.data.campaignId,
      campaignStatus: parsed.data.campaignStatus ?? null,
      failureReason: reasonOf(parsed.data.failureReasons),
    };
  }

  private assignmentOf(body: unknown): TenDlcAssignment {
    const parsed = assignmentSchema.safeParse(unwrap(body));
    if (!parsed.success) throw new TelnyxApiError(200, 'invalid_response');
    return {
      phoneNumber: parsed.data.phoneNumber,
      campaignId: parsed.data.campaignId ?? null,
      assignmentStatus: parsed.data.assignmentStatus ?? null,
      failureReason: reasonOf(parsed.data.failureReasons),
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new TelnyxApiError(0, timedOut ? 'timeout' : 'network_error');
    }
    if (!res.ok) throw new TelnyxApiError(res.status, await errorCode(res));
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      throw new TelnyxApiError(res.status, 'invalid_response');
    }
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const parsed = errorSchema.safeParse(await res.json());
    const code = parsed.success ? String(parsed.data.errors[0]?.code ?? '') : '';
    return SAFE_CODE.test(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** What a campaign status means for the registration (Telnyx's EVT lifecycle). */
export function campaignPhase(status: string | null): 'pending' | 'approved' | 'rejected' {
  switch (status) {
    case 'MNO_PROVISIONED':
      return 'approved';
    case 'TCR_FAILED':
    case 'TELNYX_FAILED':
    case 'MNO_REJECTED':
    case 'MNO_PROVISIONING_FAILED':
    case 'TCR_SUSPENDED':
    case 'TCR_EXPIRED':
      return 'rejected';
    default:
      return 'pending';
  }
}

/**
 * Identities a campaign can be built on. SELF_DECLARED is included: the guides disagree on what it
 * means, and a campaign Telnyx refuses is simply tried again on the next check.
 */
const VERIFIED_IDENTITIES: ReadonlySet<string> = new Set([
  'VERIFIED',
  'VETTED_VERIFIED',
  'SELF_DECLARED',
]);

/** What a brand's statuses mean: a campaign can be created once it is verified (or vetted). */
export function brandPhase(brand: TenDlcBrand): 'pending' | 'verified' | 'rejected' {
  if (brand.status === 'REGISTRATION_FAILED' || brand.identityStatus === 'UNVERIFIED')
    return 'rejected';
  if (VERIFIED_IDENTITIES.has(brand.identityStatus ?? '')) return 'verified';
  return 'pending';
}

/** What an assignment status means for the number. */
export function assignmentPhase(status: string | null): 'pending' | 'assigned' | 'failed' {
  if (status === 'ASSIGNED') return 'assigned';
  if (status?.startsWith('FAILED_')) return 'failed';
  return 'pending';
}

import { parseDecimalMicros, type TenDlcState } from '@knoqra/core';
import { z } from 'zod';
import { assertUsE164, clampLimit, validateSearch } from '../number-input';
import type {
  AuthorizedCallRequest,
  AvailableNumber,
  BalanceProvider,
  DateRange,
  NumberOrderInput,
  NumberOrderResult,
  NumberPurchaseProvider,
  NumberReleaseProvider,
  NumberReleaseResult,
  NumberSearch,
  NumbersProvider,
  ProviderBalance,
  ProviderCall,
  ProviderNumber,
  ProviderUsage,
  SessionInput,
  ShortLivedVoiceCredential,
  VoiceProvider,
} from '../types';
import { utf8ToBase64 } from './base64';
import { TelnyxApiError } from './errors';
import {
  type TelnyxWhatsAppAccount,
  type TelnyxWhatsAppNumber,
  type WhatsAppNumberFacts,
  whatsappAccountsPageSchema,
  whatsappFactsByNumber,
  whatsappNumbersPageSchema,
} from './whatsapp-accounts';

const DEFAULT_API_BASE = 'https://api.telnyx.com/v2';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const SAFE_CODE = /^[\w.-]{1,40}$/;

const credentialSchema = z.object({ data: z.object({ id: z.string().min(1) }) });
const callSchema = z.object({ data: z.object({ call_control_id: z.string().min(1) }) });
const PAGE_SIZE = '250';
const DEFAULT_MAX_PAGES = 200;

const metaSchema = z.object({ page_number: z.number(), total_pages: z.number() });
const balanceSchema = z.object({
  data: z.object({ balance: z.string(), currency: z.string() }),
});
const numbersPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      phone_number: z.string().min(1),
      status: z.string(),
      connection_id: z.string().nullish(),
      messaging_profile_id: z.string().nullish(),
    }),
  ),
  meta: metaSchema,
});
const campaignsSchema = z.object({
  records: z.array(z.object({ phoneNumber: z.string(), assignmentStatus: z.string() })),
});
const detailRecordsPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      started_at: z.string().min(1),
      billed_sec: z.number().int().nonnegative(),
      cost: z.string(),
      currency: z.string(),
    }),
  ),
  meta: metaSchema,
});

const QUOTE_LOOKUP_LIMIT = '10';

const availableSchema = z.object({
  data: z.array(
    z.object({
      phone_number: z.string().min(1),
      region_information: z
        .array(z.object({ region_type: z.string(), region_name: z.string() }))
        .nullish(),
      cost_information: z.object({
        upfront_cost: z.string(),
        monthly_cost: z.string(),
        currency: z.string(),
      }),
      features: z.array(z.object({ name: z.string() })).nullish(),
    }),
  ),
});
const orderSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.string(),
    phone_numbers: z.array(z.object({ phone_number: z.string() })).nullish(),
  }),
});

function mapOrderStatus(status: string): NumberOrderResult['status'] {
  if (status === 'success') return 'completed';
  return status === 'failure' ? 'failed' : 'pending';
}

const PENDING_STATUSES = new Set(['purchase-pending', 'port-pending', 'pending']);

function mapStatus(status: string): ProviderNumber['status'] {
  if (status === 'active') return 'active';
  return PENDING_STATUSES.has(status) ? 'pending' : 'inactive';
}

function mapCampaignStatus(status: string | undefined, sms: boolean): TenDlcState {
  const fallback: TenDlcState = sms ? 'none' : 'not_required';
  if (status === undefined) return fallback;
  if (status === 'ASSIGNED') return 'registered';
  if (status.startsWith('PENDING_')) return 'pending';
  if (status.startsWith('FAILED_')) return 'failed';
  return fallback;
}

function query(pairs: [string, string][]): string {
  return new URLSearchParams(pairs).toString();
}

const errorSchema = z.object({
  errors: z.array(z.object({ code: z.union([z.string(), z.number()]) })),
});

export interface TelnyxProviderOptions {
  apiKey: string;
  connectionId: string;
  telephonyCredentialId?: string | null;
  callerIdE164?: string | null;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Page cap for paged reads; reaching it is an error, never a partial result. */
  maxPages?: number;
  /** Current time in epoch milliseconds. */
  now?: () => number;
}

export class TelnyxProvider
  implements
    VoiceProvider,
    NumbersProvider,
    NumberPurchaseProvider,
    NumberReleaseProvider,
    BalanceProvider
{
  /** The credential used by the latest `createClientSession`, so the caller can persist it. */
  lastTelephonyCredentialId: string | null;

  readonly #apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly maxPages: number;

  private readonly connectionId: string;
  private readonly knownCredentialId: string | null;

  constructor(opts: TelnyxProviderOptions) {
    this.#apiKey = opts.apiKey;
    this.connectionId = opts.connectionId;
    this.knownCredentialId = opts.telephonyCredentialId ? opts.telephonyCredentialId : null;
    this.lastTelephonyCredentialId = this.knownCredentialId;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.now = opts.now ?? Date.now;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async searchAvailableNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    validateSearch(q);
    const pairs: [string, string][] = [['filter[country_code]', q.country]];
    if (q.areaCode) pairs.push(['filter[national_destination_code]', q.areaCode]);
    if (q.locality) pairs.push(['filter[locality]', q.locality]);
    if (q.region) pairs.push(['filter[administrative_area]', q.region]);
    for (const feature of q.features) pairs.push(['filter[features][]', feature]);
    pairs.push(['filter[limit]', String(clampLimit(q.limit))]);
    return this.readAvailable(`/available_phone_numbers?${query(pairs)}`);
  }

  async quoteNumber(e164: string, country: 'US' | 'CA' = 'US'): Promise<AvailableNumber | null> {
    assertUsE164(e164);
    const found = await this.readAvailable(
      `/available_phone_numbers?${query([
        ['filter[country_code]', country],
        ['filter[phone_number][contains]', e164.slice(2)],
        ['filter[limit]', QUOTE_LOOKUP_LIMIT],
      ])}`,
    );
    return found.find((n) => n.e164 === e164) ?? null;
  }

  async orderNumber(input: NumberOrderInput): Promise<NumberOrderResult> {
    assertUsE164(input.e164);
    const body: Record<string, unknown> = { phone_numbers: [{ phone_number: input.e164 }] };
    if (input.connectionId !== null) body.connection_id = input.connectionId;
    if (input.messagingProfileId) body.messaging_profile_id = input.messagingProfileId;
    if (input.customerReference) body.customer_reference = input.customerReference;
    const res = await this.post('/number_orders', body);
    const { data } = await this.readJson(res, orderSchema);
    return {
      providerOrderId: data.id,
      status: mapOrderStatus(data.status),
      e164: data.phone_numbers?.[0]?.phone_number ?? input.e164,
    };
  }

  /**
   * Releases a number: `DELETE /v2/phone_numbers/{id}`, which answers the number with status
   * `deleted` and stops its monthly charge. A 404 means Telnyx no longer has it (an earlier release
   * whose answer was lost), so it is `not_found`, not an error.
   */
  async releaseNumber(providerNumberId: string): Promise<NumberReleaseResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(providerNumberId)) {
      throw new TelnyxApiError(400, 'invalid_number_id');
    }
    const res = await this.fetchImpl(
      `${this.apiBase}/phone_numbers/${encodeURIComponent(providerNumberId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${this.#apiKey}` } },
    );
    if (res.status === 404) {
      await res.body?.cancel();
      return 'not_found';
    }
    if (!res.ok) throw new TelnyxApiError(res.status, await errorCode(res));
    await res.body?.cancel();
    return 'released';
  }

  private async readAvailable(path: string): Promise<AvailableNumber[]> {
    const res = await this.get(path);
    const { data } = await this.readJson(res, availableSchema);
    return data.map((row) => {
      const upfrontMicros = parseDecimalMicros(row.cost_information.upfront_cost);
      const monthlyMicros = parseDecimalMicros(row.cost_information.monthly_cost);
      if (
        row.cost_information.currency !== 'USD' ||
        upfrontMicros === null ||
        monthlyMicros === null ||
        upfrontMicros < 0 ||
        monthlyMicros < 0
      ) {
        throw new TelnyxApiError(res.status, 'invalid_response');
      }
      const regionName = (type: string): string | null =>
        row.region_information?.find((r) => r.region_type === type)?.region_name ?? null;
      const has = (name: string): boolean => row.features?.some((f) => f.name === name) ?? false;
      return {
        e164: row.phone_number,
        locality: regionName('rate_center') ?? regionName('location'),
        region: regionName('state'),
        capabilities: { voice: has('voice'), sms: has('sms'), mms: has('mms') },
        upfrontMicros,
        monthlyMicros,
        currency: 'USD' as const,
      };
    });
  }

  async fetchBalance(): Promise<ProviderBalance> {
    const res = await this.get('/balance');
    const { data } = await this.readJson(res, balanceSchema);
    const balanceMicros = parseDecimalMicros(data.balance);
    if (data.currency !== 'USD' || balanceMicros === null) {
      throw new TelnyxApiError(res.status, 'invalid_response');
    }
    return { balanceMicros, currency: 'USD' };
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    const rows: z.infer<typeof numbersPageSchema>['data'] = [];
    await this.eachPage(
      (page) =>
        `/phone_numbers?${query([
          ['page[number]', String(page)],
          ['page[size]', PAGE_SIZE],
        ])}`,
      numbersPageSchema,
      (data) => {
        rows.push(...data);
      },
    );
    const campaignRes = await this.get(
      `/10dlc/phone_number_campaigns?${query([['page[size]', PAGE_SIZE]])}`,
    );
    const { records } = await this.readJson(campaignRes, campaignsSchema);
    const campaigns = new Map(records.map((r) => [r.phoneNumber, r.assignmentStatus]));
    const whatsapp = await this.readWhatsAppFacts();
    return rows.map((row) => {
      const sms = row.messaging_profile_id != null;
      const facts = whatsapp?.get(row.phone_number);
      return {
        providerNumberId: row.id,
        e164: row.phone_number,
        status: mapStatus(row.status),
        capabilities: {
          voice: row.connection_id != null,
          sms,
          mms: sms,
          whatsapp: facts !== undefined,
        },
        tenDlc: mapCampaignStatus(campaigns.get(row.phone_number), sms),
        whatsapp: facts?.state ?? 'none',
        ...(whatsapp === null ? { whatsappSynced: false } : {}),
        ...(facts
          ? {
              whatsappDetail: {
                displayName: facts.displayName,
                qualityRating: facts.qualityRating,
              },
            }
          : {}),
      };
    });
  }

  /**
   * The account's WhatsApp numbers and Meta's verdict on each (whatsapp-accounts.ts). A 404 on
   * these reads means no WhatsApp product: an empty map. Anything else that fails, a 401 or 403
   * from a restricted key included, is unknown: null, so the sync keeps what it knew instead of
   * dropping a live WhatsApp sender.
   */
  async readWhatsAppFacts(): Promise<Map<string, WhatsAppNumberFacts> | null> {
    const numbers: TelnyxWhatsAppNumber[] = [];
    const accounts: TelnyxWhatsAppAccount[] = [];
    try {
      await this.eachPage(
        (page) =>
          `/whatsapp/phone_numbers?${query([
            ['page[number]', String(page)],
            ['page[size]', PAGE_SIZE],
          ])}`,
        whatsappNumbersPageSchema,
        (data) => {
          numbers.push(...data);
        },
      );
      if (numbers.length > 0) {
        await this.eachPage(
          (page) =>
            `/whatsapp/business_accounts?${query([
              ['page[number]', String(page)],
              ['page[size]', PAGE_SIZE],
            ])}`,
          whatsappAccountsPageSchema,
          (data) => {
            accounts.push(...data);
          },
        );
      }
    } catch (error) {
      if (error instanceof TelnyxApiError && error.status === 404) return new Map();
      return null;
    }
    return whatsappFactsByNumber(numbers, accounts);
  }

  async fetchUsage(period: DateRange): Promise<ProviderUsage[]> {
    const usage: ProviderUsage[] = [];
    await this.eachPage(
      (page) =>
        `/detail_records?${query([
          ['filter[record_type]', 'call-control'],
          ['filter[started_at][gte]', period.from],
          ['filter[started_at][lt]', period.to],
          ['page[number]', String(page)],
          ['page[size]', PAGE_SIZE],
        ])}`,
      detailRecordsPageSchema,
      (data, status) => {
        for (const r of data) {
          const costMicros = parseDecimalMicros(r.cost);
          if (r.currency !== 'USD' || costMicros === null || costMicros < 0) {
            throw new TelnyxApiError(status, 'invalid_response');
          }
          usage.push({
            service: 'voice',
            quantity: r.billed_sec,
            unit: 'second',
            costMicros,
            occurredAt: r.started_at,
            providerRef: r.id,
          });
        }
      },
    );
    return usage;
  }

  /**
   * Reads numbered pages until `page_number >= total_pages`. Never returns a partial result: hitting
   * the page cap, or a page that is empty while more are promised, is an `invalid_response`.
   */
  private async eachPage<D>(
    pathFor: (page: number) => string,
    schema: z.ZodType<{ data: D[]; meta: { page_number: number; total_pages: number } }>,
    onPage: (data: D[], status: number) => void,
  ): Promise<void> {
    let status = 200;
    for (let page = 1; page <= this.maxPages; page++) {
      const res = await this.get(pathFor(page));
      status = res.status;
      const body = await this.readJson(res, schema);
      onPage(body.data, status);
      if (body.meta.page_number >= body.meta.total_pages) return;
      if (body.data.length === 0) break;
    }
    throw new TelnyxApiError(status, 'invalid_response');
  }

  async createClientSession(input: SessionInput): Promise<ShortLivedVoiceCredential> {
    let credentialId = this.knownCredentialId ?? this.lastTelephonyCredentialId;
    if (credentialId === null) {
      const created = await this.post('/telephony_credentials', {
        connection_id: this.connectionId,
        name: `knoqra-${input.orgId}`,
      });
      credentialId = (await this.readJson(created, credentialSchema)).data.id;
    }
    this.lastTelephonyCredentialId = credentialId;
    const res = await this.post(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`);
    const token = await this.readText(res);
    return {
      token,
      expiresAt: new Date(this.now() + TOKEN_TTL_MS).toISOString(),
    };
  }

  async createCall(input: AuthorizedCallRequest): Promise<ProviderCall> {
    const res = await this.post('/calls', {
      connection_id: this.connectionId,
      to: input.to,
      from: input.from,
      client_state: utf8ToBase64(input.idempotencyKey),
    });
    const { data } = await this.readJson(res, callSchema);
    return { providerCallId: data.call_control_id, state: 'queued' };
  }

  async endCall(callControlId: string): Promise<void> {
    await this.post(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
  }

  private async readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(await res.json());
    } catch {
      throw new TelnyxApiError(res.status, 'invalid_response');
    }
  }

  private async readText(res: Response): Promise<string> {
    let text = '';
    try {
      text = (await res.text()).trim();
    } catch {
      // fall through to the empty check
    }
    if (text.length === 0) throw new TelnyxApiError(res.status, 'invalid_response');
    return text;
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.#apiKey}` },
    });
    if (!res.ok) throw new TelnyxApiError(res.status, await errorCode(res));
    return res;
  }

  private async post(path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#apiKey}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new TelnyxApiError(res.status, await errorCode(res));
    return res;
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

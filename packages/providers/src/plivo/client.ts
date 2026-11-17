import { parseDecimalMicros } from '@knoqra/core';
import { z } from 'zod';
import { assertUsE164, clampLimit, validateSearch } from '../number-input';
import { utf8ToBase64 } from '../telnyx/base64';
import type {
  AuthorizedCallRequest,
  AvailableNumber,
  BalanceProvider,
  DateRange,
  NumberFeature,
  NumberOrderResult,
  NumberPurchaseProvider,
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
import { clampTimeLimit } from '../types';
import { PlivoApiError } from './errors';
import { CLIENT_STATE_FIELD } from './normalize';

const DEFAULT_API_BASE = 'https://api.plivo.com/v1';
/** Plivo's longest access token lifetime. */
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Plivo pages hold at most 20 objects. */
const PAGE_LIMIT = 20;
const DEFAULT_MAX_PAGES = 200;
const CALL_UUID = /^[A-Za-z0-9-]{1,64}$/;
/** The service sets Plivo's search accepts; anything else is searched as all three, then filtered. */
const SERVICE_SETS = new Set(['voice', 'sms', 'mms', 'voice,sms', 'voice,sms,mms']);
const FEATURE_ORDER: NumberFeature[] = ['voice', 'sms', 'mms'];

const amount = z.union([z.string(), z.number()]).transform(String);
const pageMeta = z.object({ next: z.string().nullish() });

const numbersPage = z.object({
  meta: pageMeta,
  objects: z.array(
    z.object({
      number: z.string().min(1),
      voice_enabled: z.boolean().nullish(),
      sms_enabled: z.boolean().nullish(),
      mms_enabled: z.boolean().nullish(),
      active: z.boolean().nullish(),
    }),
  ),
});
const searchPage = z.object({
  objects: z.array(
    z.object({
      number: z.string().min(1),
      city: z.string().nullish(),
      rate_center: z.string().nullish(),
      region: z.string().nullish(),
      setup_rate: amount,
      monthly_rental_rate: amount,
      voice_enabled: z.boolean().nullish(),
      sms_enabled: z.boolean().nullish(),
      mms_enabled: z.boolean().nullish(),
      restriction: z.string().nullish(),
    }),
  ),
});
const orderSchema = z.object({
  api_id: z.string().nullish(),
  status: z.string(),
  numbers: z.array(z.object({ number: z.string(), status: z.string().nullish() })).nullish(),
});
const accountSchema = z.object({ cash_credits: amount });
const cdrPage = z.object({
  meta: pageMeta,
  objects: z.array(
    z.object({
      call_uuid: z.string().min(1),
      bill_duration: z.number().int().nonnegative(),
      total_amount: amount,
      end_time: z.string().min(1),
    }),
  ),
});
const endpointSchema = z.object({ username: z.string().min(1) });
const tokenSchema = z.object({ token: z.string().min(1) });
const callSchema = z.object({ request_uuid: z.string().min(1) });

/** `14155550123` (Plivo's form) to E.164. */
const toE164 = (digits: string): string => `+${digits.replace(/^\+/, '')}`;
/** E.164 to Plivo's form, without `+`. */
const toPlivoNumber = (e164: string): string => e164.replace(/^\+/, '');

/** Plivo time filters take `YYYY-MM-DD HH:MM:SS`; KNOQRA sends UTC. */
function plivoTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new RangeError('invalid_period');
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/** `2026-11-11 10:00:00+05:30` or `2026-11-11 10:00:00` (read as UTC) to ISO, or null. */
export function parsePlivoTime(value: string): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const offset = match[3] ?? 'Z';
  const at = Date.parse(`${match[1]}T${match[2]}${offset}`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function serviceSet(features: NumberFeature[]): string {
  const wanted = FEATURE_ORDER.filter((f) => features.includes(f)).join(',');
  if (wanted === '') return 'voice';
  return SERVICE_SETS.has(wanted) ? wanted : 'voice,sms,mms';
}

function randomToken(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export interface PlivoProviderOptions {
  /** The account's Auth ID (not secret). */
  authId: string;
  /** The account's Auth Token (secret). */
  authToken: string;
  /** The Plivo application whose answer URL points at KNOQRA. */
  appId: string;
  /** The endpoint the browser logs in as, once one exists (stored with the connection). */
  endpointUsername?: string | null;
  /** Where Plivo asks what to do with a call (`createCall` only). */
  answerUrl?: string | null;
  /** Where Plivo reports the end of a call (`createCall` only). */
  hangupUrl?: string | null;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Page cap for paged reads; reaching it is an error, never a partial result. */
  maxPages?: number;
  /** Current time in epoch milliseconds. */
  now?: () => number;
}

/**
 * Plivo REST v1 (`https://api.plivo.com/v1/Account/<authId>/`, HTTP Basic auth, JSON bodies).
 * Built from Plivo's public docs and SDK source; not yet run against a live account.
 */
export class PlivoProvider
  implements VoiceProvider, NumbersProvider, NumberPurchaseProvider, BalanceProvider
{
  /** The endpoint used by the latest `createClientSession`, so the caller can persist it. */
  lastEndpointUsername: string | null;

  readonly #authorization: string;
  private readonly authId: string;
  private readonly appId: string;
  private readonly answerUrl: string | null;
  private readonly hangupUrl: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly accountBase: string;
  private readonly now: () => number;
  private readonly maxPages: number;

  constructor(opts: PlivoProviderOptions) {
    this.authId = opts.authId;
    this.#authorization = `Basic ${utf8ToBase64(`${opts.authId}:${opts.authToken}`)}`;
    this.appId = opts.appId;
    this.lastEndpointUsername = opts.endpointUsername ? opts.endpointUsername : null;
    this.answerUrl = opts.answerUrl ?? null;
    this.hangupUrl = opts.hangupUrl ?? null;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.accountBase = `${opts.apiBase ?? DEFAULT_API_BASE}/Account/${encodeURIComponent(opts.authId)}`;
    this.now = opts.now ?? Date.now;
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * Creates the workspace's browser endpoint on first use (attached to the application), then asks
   * Plivo for an access token for it. Plivo signs the token; a locally signed one is refused.
   */
  async createClientSession(input: SessionInput): Promise<ShortLivedVoiceCredential> {
    let username = this.lastEndpointUsername;
    if (username === null) {
      const created = await this.request('POST', '/Endpoint/', {
        username: `knoqra${randomToken(10)}`,
        password: randomToken(24),
        alias: `knoqra-${input.orgId}`.slice(0, 50),
        app_id: this.appId,
      });
      username = (await this.readJson(created, endpointSchema)).username;
    }
    this.lastEndpointUsername = username;
    const nbf = Math.floor(this.now() / 1000);
    const exp = nbf + TOKEN_TTL_SECONDS;
    const res = await this.request('POST', '/JWT/Token/', {
      iss: this.authId,
      sub: username,
      nbf,
      exp,
      per: { voice: { incoming_allow: true, outgoing_allow: true } },
      app: this.appId,
    });
    const { token } = await this.readJson(res, tokenSchema);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Places a call from the server. Plivo answers with a request id; the call id comes later. */
  async createCall(input: AuthorizedCallRequest): Promise<ProviderCall> {
    if (this.answerUrl === null) throw new PlivoApiError(0, 'not_configured');
    const body: Record<string, unknown> = {
      from: toPlivoNumber(input.from),
      to: toPlivoNumber(input.to),
      answer_url: this.answerUrl,
      answer_method: 'POST',
      sip_headers: `${CLIENT_STATE_FIELD.replace(/^X-PH-/, '')}=${input.idempotencyKey}`,
    };
    // Plivo hangs the call up itself at this limit.
    if (input.timeLimitSecs !== undefined) {
      body.time_limit = clampTimeLimit(input.timeLimitSecs, 1, 86_400);
    }
    if (this.hangupUrl !== null) {
      body.hangup_url = this.hangupUrl;
      body.hangup_method = 'POST';
    }
    const res = await this.request('POST', '/Call/', body);
    const { request_uuid } = await this.readJson(res, callSchema);
    return { providerCallId: request_uuid, state: 'queued' };
  }

  /**
   * Hangs up one live call. The id is checked first: Plivo's hangup with no call id disconnects
   * every ongoing call of the account.
   */
  async endCall(callUuid: string): Promise<void> {
    if (!CALL_UUID.test(callUuid)) throw new RangeError('invalid_call_id');
    await this.request('DELETE', `/Call/${encodeURIComponent(callUuid)}/`);
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    const rows: z.infer<typeof numbersPage>['objects'] = [];
    await this.eachPage('/Number/', [], numbersPage, (objects) => {
      rows.push(...objects);
    });
    return rows.map((row) => {
      return {
        providerNumberId: row.number,
        e164: toE164(row.number),
        status: row.active === false ? 'inactive' : 'active',
        capabilities: {
          voice: row.voice_enabled === true,
          sms: row.sms_enabled === true,
          mms: row.mms_enabled === true,
          whatsapp: false,
        },
        // KNOQRA sends no messages through Plivo, so 10DLC is not required for its use here.
        tenDlc: 'not_required',
        whatsapp: 'none',
      };
    });
  }

  async searchAvailableNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    validateSearch(q);
    const pairs: [string, string][] = [
      ['country_iso', q.country],
      ['type', 'local'],
      ['services', serviceSet(q.features)],
    ];
    if (q.areaCode) pairs.push(['pattern', q.areaCode]);
    if (q.region) pairs.push(['region', q.region]);
    if (q.locality) pairs.push(['city', q.locality]);
    pairs.push(['limit', String(clampLimit(q.limit))]);
    const found = await this.readAvailable(pairs);
    return found.filter((n) => q.features.every((f) => n.capabilities[f]));
  }

  async quoteNumber(e164: string): Promise<AvailableNumber | null> {
    assertUsE164(e164);
    const found = await this.readAvailable([
      ['country_iso', 'US'],
      ['type', 'local'],
      ['pattern', e164.slice(2)],
      ['limit', String(PAGE_LIMIT)],
    ]);
    return found.find((n) => n.e164 === e164) ?? null;
  }

  /** Rents the number and attaches it to the connection's application. */
  async orderNumber(input: {
    e164: string;
    connectionId: string | null;
  }): Promise<NumberOrderResult> {
    assertUsE164(input.e164);
    const digits = toPlivoNumber(input.e164);
    const res = await this.request('POST', `/PhoneNumber/${digits}/`, {
      app_id: input.connectionId ?? this.appId,
    });
    const data = await this.readJson(res, orderSchema);
    const status: NumberOrderResult['status'] =
      data.status === 'fulfilled' ? 'completed' : data.status === 'pending' ? 'pending' : 'failed';
    return {
      // Plivo returns no order id; its request id identifies this order in Plivo's logs.
      providerOrderId: data.api_id ?? `plivo-${digits}`,
      status,
      e164: data.numbers?.[0]?.number ? toE164(data.numbers[0].number) : input.e164,
    };
  }

  async fetchBalance(): Promise<ProviderBalance> {
    const res = await this.request('GET', '/');
    const { cash_credits } = await this.readJson(res, accountSchema);
    const balanceMicros = parseDecimalMicros(cash_credits);
    if (balanceMicros === null) throw new PlivoApiError(res.status, 'invalid_response');
    return { balanceMicros, currency: 'USD' };
  }

  async fetchUsage(period: DateRange): Promise<ProviderUsage[]> {
    const usage: ProviderUsage[] = [];
    const filters: [string, string][] = [
      ['end_time__gte', plivoTime(period.from)],
      ['end_time__lt', plivoTime(period.to)],
    ];
    await this.eachPage('/Call/', filters, cdrPage, (objects, status) => {
      for (const r of objects) {
        const costMicros = parseDecimalMicros(r.total_amount);
        const occurredAt = parsePlivoTime(r.end_time);
        if (costMicros === null || costMicros < 0 || occurredAt === null) {
          throw new PlivoApiError(status, 'invalid_response');
        }
        usage.push({
          service: 'voice',
          quantity: r.bill_duration,
          unit: 'second',
          costMicros,
          occurredAt,
          providerRef: r.call_uuid,
        });
      }
    });
    return usage;
  }

  private async readAvailable(pairs: [string, string][]): Promise<AvailableNumber[]> {
    const res = await this.request('GET', `/PhoneNumber/?${new URLSearchParams(pairs)}`);
    const { objects } = await this.readJson(res, searchPage);
    // A restricted number needs address or identity documents first: it cannot be bought here.
    return objects
      .filter((row) => !row.restriction)
      .map((row) => {
        const upfrontMicros = parseDecimalMicros(row.setup_rate);
        const monthlyMicros = parseDecimalMicros(row.monthly_rental_rate);
        if (
          upfrontMicros === null ||
          monthlyMicros === null ||
          upfrontMicros < 0 ||
          monthlyMicros < 0
        ) {
          throw new PlivoApiError(res.status, 'invalid_response');
        }
        return {
          e164: toE164(row.number),
          locality: row.city ?? row.rate_center ?? null,
          region: row.region ?? null,
          capabilities: {
            voice: row.voice_enabled === true,
            sms: row.sms_enabled === true,
            mms: row.mms_enabled === true,
          },
          upfrontMicros,
          monthlyMicros,
          currency: 'USD' as const,
        };
      });
  }

  /**
   * Reads `limit`/`offset` pages until `meta.next` is empty. Never returns a partial result:
   * hitting the page cap, or an empty page while more are promised, is an `invalid_response`.
   */
  private async eachPage<D>(
    path: string,
    filters: [string, string][],
    schema: z.ZodType<{ meta: { next?: string | null | undefined }; objects: D[] }>,
    onPage: (objects: D[], status: number) => void,
  ): Promise<void> {
    let status = 200;
    for (let page = 0; page < this.maxPages; page++) {
      const query = new URLSearchParams([
        ...filters,
        ['limit', String(PAGE_LIMIT)],
        ['offset', String(page * PAGE_LIMIT)],
      ]);
      const res = await this.request('GET', `${path}?${query}`);
      status = res.status;
      const body = await this.readJson(res, schema);
      onPage(body.objects, status);
      if (!body.meta.next) return;
      if (body.objects.length === 0) break;
    }
    throw new PlivoApiError(status, 'invalid_response');
  }

  private async readJson<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
    try {
      return schema.parse(await res.json());
    } catch {
      throw new PlivoApiError(res.status, 'invalid_response');
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: this.#authorization };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetchImpl(`${this.accountBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // The body is never read on failure: Plivo's error text can echo request details.
    if (!res.ok) throw new PlivoApiError(res.status);
    return res;
  }
}

import { describe, expect, it } from 'vitest';
import type {
  BalanceProvider,
  DateRange,
  NumberPurchaseProvider,
  NumberSearch,
  NumbersProvider,
  VoiceProvider,
  WebhookAdapter,
} from './types';

const enc = new TextEncoder();

type Signed = { adapter: WebhookAdapter; headers: Headers };

const baseBody = {
  id: 'ev_contract_1',
  type: 'call.answered',
  occurred_at: '2026-11-11T10:00:00.000Z',
  resource_id: 'call_contract_1',
  payload: {},
};

const bytesOf = (value: unknown): Uint8Array => enc.encode(JSON.stringify(value));

/**
 * Behavior every WebhookAdapter must have. Test helper only: not exported from the package index,
 * so it never ships in app bundles.
 */
export function runAdapterContract(
  name: string,
  makeSigned: (body: Uint8Array) => Promise<Signed>,
  opts: {
    envelope?: (base: typeof baseBody, type: string) => unknown;
    /** How a body value becomes bytes on the wire. JSON by default; Plivo posts form fields. */
    encode?: (value: unknown) => Uint8Array;
  } = {},
): void {
  const encode = opts.encode ?? bytesOf;
  describe(`${name} adapter contract`, () => {
    it('accepts a valid signature', async () => {
      const body = encode(baseBody);
      const { adapter, headers } = await makeSigned(body);
      expect(await adapter.verify(headers, body)).toBe(true);
    });

    it('rejects a one-byte change', async () => {
      const body = encode(baseBody);
      const { adapter, headers } = await makeSigned(body);
      const changed = body.slice();
      changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;
      expect(await adapter.verify(headers, changed)).toBe(false);
    });

    it('verifies over exact bytes: NBSP, U+2028, CRLF and non-UTF-8 sequences', async () => {
      const text = enc.encode(
        '{"id":"ev_bytes","note":"a b c\r\nd","type":"call.answered",\r\n"raw":"',
      );
      const tail = enc.encode('"}');
      const body = new Uint8Array(text.length + 3 + tail.length);
      body.set(text, 0);
      body.set([0xff, 0xfe, 0xc3], text.length);
      body.set(tail, text.length + 3);
      const { adapter, headers } = await makeSigned(body);
      expect(await adapter.verify(headers, body)).toBe(true);
      const changed = body.slice();
      changed[text.length] = 0xfd;
      expect(await adapter.verify(headers, changed)).toBe(false);
    });

    it('returns invalid_payload for malformed JSON', async () => {
      const body = enc.encode('not json');
      const { adapter } = await makeSigned(body);
      expect(adapter.parse(body)).toEqual({ ok: false, error: 'invalid_payload' });
    });

    it('returns ignored for a well-formed unknown event type', async () => {
      const body = encode(
        opts.envelope
          ? opts.envelope(baseBody, 'call.exploded')
          : { ...baseBody, type: 'call.exploded' },
      );
      const { adapter } = await makeSigned(body);
      expect(adapter.parse(body)).toEqual({
        ok: true,
        value: { kind: 'ignored', eventType: 'call.exploded' },
      });
    });
  });
}

const E164 = /^\+[1-9]\d{6,14}$/;
const NUMBER_STATUSES = new Set(['active', 'pending', 'inactive']);

const isMicros = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** What a provider under contract is built from: its fixtures decide the inputs. */
export interface ProviderContractSubject {
  provider: VoiceProvider & NumbersProvider & NumberPurchaseProvider & BalanceProvider;
  /** A search its fixtures answer with at least one number. */
  search: NumberSearch;
  /** A US number in E.164 that the provider does not offer. */
  unlistedE164: string;
  /** A period its fixtures answer with usage. */
  period: DateRange;
  /** The provider's clock, epoch milliseconds. */
  now: number;
}

/**
 * Behavior every voice, numbers, purchase and balance provider must have, whichever account it
 * talks to. Test helper only, like `runAdapterContract`. `make` builds a fresh subject per test,
 * so a stub that records calls never leaks state between tests.
 */
export function runProviderContract(
  name: string,
  make: () => ProviderContractSubject | Promise<ProviderContractSubject>,
): void {
  describe(`${name} provider contract`, () => {
    it('issues a client session with a token and a future expiry', async () => {
      const { provider, now } = await make();
      const session = await provider.createClientSession({ orgId: 'org_contract', userId: 'u_1' });
      expect(session.token.length).toBeGreaterThan(0);
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(now);
    });

    it('lists numbers in E.164 with a known status', async () => {
      const { provider } = await make();
      const numbers = await provider.listNumbers();
      expect(numbers.length).toBeGreaterThan(0);
      for (const n of numbers) {
        expect(n.e164).toMatch(E164);
        expect(n.providerNumberId.length).toBeGreaterThan(0);
        expect(NUMBER_STATUSES.has(n.status)).toBe(true);
        expect(Object.values(n.capabilities).every((v) => typeof v === 'boolean')).toBe(true);
      }
    });

    it('searches within the limit, priced in USD integer micros', async () => {
      const { provider, search } = await make();
      const found = await provider.searchAvailableNumbers(search);
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(search.limit ?? 20);
      for (const n of found) {
        expect(n.e164).toMatch(E164);
        expect(n.currency).toBe('USD');
        expect(isMicros(n.upfrontMicros)).toBe(true);
        expect(isMicros(n.monthlyMicros)).toBe(true);
      }
    });

    it('quotes a listed number at its listed price, and an unlisted number as null', async () => {
      const { provider, search, unlistedE164 } = await make();
      const [first] = await provider.searchAvailableNumbers(search);
      if (!first) throw new Error('the search fixture must list a number');
      const quote = await provider.quoteNumber(first.e164);
      expect(quote?.e164).toBe(first.e164);
      expect(quote?.upfrontMicros).toBe(first.upfrontMicros);
      expect(quote?.monthlyMicros).toBe(first.monthlyMicros);
      expect(await provider.quoteNumber(unlistedE164)).toBeNull();
    });

    it('refuses to quote or order a number outside the US', async () => {
      const { provider } = await make();
      await expect(provider.quoteNumber('+442071234567')).rejects.toThrow(RangeError);
      await expect(
        provider.orderNumber({ e164: '+442071234567', connectionId: null }),
      ).rejects.toThrow(RangeError);
    });

    it('reports usage as non-negative whole seconds and micros', async () => {
      const { provider, period } = await make();
      const usage = await provider.fetchUsage(period);
      expect(usage.length).toBeGreaterThan(0);
      for (const u of usage) {
        expect(u.service).toBe('voice');
        expect(u.unit).toBe('second');
        expect(isMicros(u.quantity)).toBe(true);
        expect(isMicros(u.costMicros)).toBe(true);
        expect(u.providerRef.length).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(u.occurredAt))).toBe(false);
      }
    });

    it('reports the balance in USD integer micros', async () => {
      const { provider } = await make();
      const balance = await provider.fetchBalance();
      expect(balance.currency).toBe('USD');
      expect(Number.isSafeInteger(balance.balanceMicros)).toBe(true);
    });
  });
}

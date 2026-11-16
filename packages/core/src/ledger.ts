import type { MessagingChannel } from './messaging/status';

/** Money is integer micros only: 1 USD = 1,000,000. */
export const VOICE_RATE_MICROS_PER_MINUTE = 10_000;
export const CALL_RESERVE_MINUTES = 10;

/**
 * The hold placed when a call starts: 10 minutes at the voice rate, plus the platform fee for those
 * minutes when one is set.
 */
export function callReserveMicros(platformFeeMicrosPerMinute = 0): number {
  return CALL_RESERVE_MINUTES * (VOICE_RATE_MICROS_PER_MINUTE + platformFeeMicrosPerMinute);
}

/**
 * The hold for a call priced per destination: 10 minutes at its price, plus the platform fee for
 * those minutes when one is set.
 */
export function callHoldMicros(
  priceMicrosPerMinute: number,
  platformFeeMicrosPerMinute = 0,
): number {
  return CALL_RESERVE_MINUTES * (priceMicrosPerMinute + platformFeeMicrosPerMinute);
}

/** KNOQRA's fee for a call: every started (billed) minute at the platform rate. */
export function platformFeeMicros(billableSeconds: number, ratePerMinute: number): number {
  return callCostMicros(billableSeconds, ratePerMinute);
}

/**
 * Flat per-message estimates ($0.01 SMS, $0.05 WhatsApp), reserved on send and captured on
 * delivery. They are not Telnyx's billed per-message cost, which is not read yet.
 */
export const MESSAGE_RATE_MICROS: Readonly<Record<MessagingChannel, number>> = {
  sms: 10_000,
  whatsapp: 50_000,
};

export function messageCostMicros(channel: MessagingChannel): number {
  return MESSAGE_RATE_MICROS[channel];
}

function assertWholeNonNegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/** Billed per started minute; 0 seconds costs nothing. */
export function callCostMicros(
  billableSeconds: number,
  ratePerMinute: number = VOICE_RATE_MICROS_PER_MINUTE,
): number {
  assertWholeNonNegative(billableSeconds, 'billableSeconds');
  assertWholeNonNegative(ratePerMinute, 'ratePerMinute');
  return Math.ceil(billableSeconds / 60) * ratePerMinute;
}

/** `fee` is KNOQRA's platform fee: a plain debit, never part of a reservation. */
export const LEDGER_KINDS = ['credit', 'adjust', 'reserve', 'capture', 'release', 'fee'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export type LedgerLine = {
  kind: LedgerKind;
  balanceDeltaMicros: number;
  heldDeltaMicros: number;
  reservationId: string | null;
  id: string;
};

export type LedgerDelta = { balanceDeltaMicros: number; heldDeltaMicros: number };

export function summarizeLedger(lines: readonly LedgerLine[]): {
  balanceMicros: number;
  heldMicros: number;
  availableMicros: number;
} {
  let balanceMicros = 0;
  let heldMicros = 0;
  for (const line of lines) {
    balanceMicros += line.balanceDeltaMicros;
    heldMicros += line.heldDeltaMicros;
  }
  return { balanceMicros, heldMicros, availableMicros: balanceMicros - heldMicros };
}

export function planReserve(amount: number): LedgerDelta {
  assertWholeNonNegative(amount, 'amount');
  return { balanceDeltaMicros: 0, heldDeltaMicros: amount };
}

export function planCapture(holdMicros: number, costMicros: number): LedgerDelta {
  assertWholeNonNegative(holdMicros, 'holdMicros');
  assertWholeNonNegative(costMicros, 'costMicros');
  return { balanceDeltaMicros: -costMicros, heldDeltaMicros: -holdMicros };
}

export function planRelease(holdMicros: number): LedgerDelta {
  assertWholeNonNegative(holdMicros, 'holdMicros');
  return { balanceDeltaMicros: 0, heldDeltaMicros: -holdMicros };
}

/**
 * Throws if the ledger breaks an invariant: settlements reference a reserve,
 * each reserve is settled at most once and frees exactly its amount, and held
 * never goes negative.
 */
export function assertLedgerInvariants(lines: readonly LedgerLine[]): void {
  const reserves = new Map<string, LedgerLine>();
  const settled = new Set<string>();
  let held = 0;
  for (const line of lines) {
    if (line.kind === 'reserve') {
      reserves.set(line.id, line);
    } else if (line.kind === 'capture' || line.kind === 'release') {
      const reserve = line.reservationId === null ? undefined : reserves.get(line.reservationId);
      if (!reserve || line.reservationId === null) {
        throw new Error(`Ledger line ${line.id} (${line.kind}) does not reference a reserve`);
      }
      if (settled.has(line.reservationId)) {
        throw new Error(`Reserve ${line.reservationId} is settled more than once`);
      }
      settled.add(line.reservationId);
      if (line.heldDeltaMicros !== -reserve.heldDeltaMicros) {
        throw new Error(`Ledger line ${line.id} does not free the held amount of its reserve`);
      }
    }
    held += line.heldDeltaMicros;
    if (held < 0) {
      throw new Error(`Held balance went negative at ledger line ${line.id}`);
    }
  }
}

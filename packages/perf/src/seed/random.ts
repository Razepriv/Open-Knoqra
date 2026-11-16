// Seeded randomness so a --reset rerun reproduces the dataset exactly.

export type Rand = () => number;

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rand {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `newId` prefixes the seed writes: M1 tables, then the Phase 1 tables. */
export type IdPrefix =
  | 'ct'
  | 'te'
  | 'cp'
  | 'dd'
  | 'cl'
  | 'vm'
  | 'cc'
  | 'cv'
  | 'mg'
  | 'ms'
  | 'mt'
  | 'tk'
  | 'nt'
  | 'wl'
  | 'le'
  | 'nq'
  | 'no'
  | 'pn'
  | 'ue'
  | 'rc';

/** An independent stream for one Phase 1 generator, so adding one never shifts another. */
export function streamRand(seed: number, salt: number): Rand {
  return mulberry32((Math.imul(seed, 1_000_003) + salt) >>> 0);
}

/** `<prefix>_<32 lowercase hex>`, the shape of `newId` in @knoqra/core. */
export function hexId(rand: Rand, prefix: IdPrefix): string {
  let hex = '';
  for (let i = 0; i < 4; i++) {
    hex += Math.floor(rand() * 4294967296)
      .toString(16)
      .padStart(8, '0');
  }
  return `${prefix}_${hex}`;
}

/** Integer in [0, n). */
export function int(rand: Rand, n: number): number {
  return Math.floor(rand() * n);
}

/** One element of a non-empty list. */
export function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[int(rand, list.length)] as T;
}

/** Index chosen by cumulative weights. */
export function weighted(rand: Rand, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i] as number;
    if (x < 0) return i;
  }
  return weights.length - 1;
}

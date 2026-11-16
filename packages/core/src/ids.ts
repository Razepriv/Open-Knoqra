export type IdPrefix =
  | 'ct'
  | 'ae'
  | 'pe'
  | 'cp'
  | 'te'
  | 'dd'
  | 'tk'
  | 'nt'
  | 'od'
  | 'ue'
  | 'cc'
  | 'cr'
  | 'cv'
  | 'mg'
  | 'ms'
  | 'mt'
  | 'pc'
  | 'cl'
  | 'ce'
  | 'vm'
  | 'wl'
  | 'le'
  | 'pn'
  | 'bs'
  | 'pu'
  | 'rc'
  | 'no'
  | 'nq'
  | 'tp'
  | 'sb';

/** `<prefix>_<32 hex>`: a UUIDv4 without dashes. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

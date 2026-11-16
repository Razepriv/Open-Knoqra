// Realtime fan-out harness configuration. `trigger` is the request that causes one broadcast,
// `expectType` the message type every socket must then receive. The trigger is the owner's
// wallet caps update with an empty body: both caps stay as they are (the route writes an audit
// row and the wallet's updated_at moves), and it always publishes `wallet.updated` to the org's
// OrgRealtime object.
export const REALTIME: {
  path: string;
  sockets: number;
  trigger: null | { method: string; path: string; body?: unknown };
  expectType: null | string;
  /** Fan-out deadline: every socket must receive `expectType` within this after the trigger. */
  timeoutMs: number;
  /**
   * Sockets opened at once. Each upgrade runs the full session and tenant lookup, which costs
   * 130-200 ms under local `wrangler dev`, so opening all 200 at once only measures that queue.
   */
  openConcurrency: number;
  /** Deadline for opening all sockets, kept apart from the fan-out deadline. */
  openTimeoutMs: number;
} = {
  path: '/api/v1/realtime',
  sockets: 200,
  trigger: { method: 'PATCH', path: '/api/v1/wallet/caps', body: {} },
  expectType: 'wallet.updated',
  timeoutMs: 10_000,
  openConcurrency: 10,
  openTimeoutMs: 60_000,
};

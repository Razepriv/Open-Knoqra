/**
 * The cross-tenant guard for per-connection webhooks. A workspace that connects its own provider
 * account signs its own deliveries, so an event verified with one workspace's key may only change
 * that workspace, whatever number or call it names. No imports: the handlers and the registry both
 * use it.
 */

/** Whether an event may change `orgId`: always for the platform URL, else only its own workspace. */
export function mayApplyTo(ctx: { connectorOrgId: string | null }, orgId: string): boolean {
  return ctx.connectorOrgId === null || ctx.connectorOrgId === orgId;
}

/** The handler result for an event signed by one workspace that resolved to another. */
export const FOREIGN_CONNECTION = { status: 'ignored', reason: 'foreign_connection' } as const;

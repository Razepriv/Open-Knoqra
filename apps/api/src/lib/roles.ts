const MANAGER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/**
 * Owners and admins manage provider settings: the voice connection, messaging senders and
 * templates. A member row may list several comma-separated roles.
 */
export const canManage = (role: string): boolean =>
  role.split(',').some((r) => MANAGER_ROLES.has(r.trim()));

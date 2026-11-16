import type { Database } from '@knoqra/db';
import type { Auth, AuthSession } from '../auth/auth';
import type { Env } from '../env';

export interface Tenant {
  orgId: string;
  userId: string;
  role: string;
}

export interface AppVariables {
  requestId: string;
  db: Database;
  auth: Auth;
  session: AuthSession;
  tenant: Tenant;
}

/** Hono generics shared by the app, middleware and routes. */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

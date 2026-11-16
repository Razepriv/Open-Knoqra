import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandle {
  db: Database;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Maximum physical connections. Default 1. */
  max?: number;
  /**
   * Give up on establishing a connection after this many milliseconds. Default: no limit (pg's
   * own default). Set it where an unresponsive server must not hang the caller (health checks).
   */
  connectionTimeoutMillis?: number;
}

/**
 * Opens a node-postgres Pool. Each `db.transaction` (and so each `withTenant`) checks out its own
 * connection, so concurrent tenant transactions on one handle never share a session. With the
 * default `max: 1` they queue instead of interleaving. Connections open lazily, and a failed
 * connect rejects the query with the real cause (bad password, refused port).
 */
export function createDb(connectionString: string, opts?: CreateDbOptions): DbHandle {
  const pool = new Pool({
    connectionString,
    max: opts?.max ?? 1,
    ...(opts?.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: opts.connectionTimeoutMillis }),
  });
  // pg emits 'error' when an idle pooled connection dies (e.g. server restart) and drops that
  // connection; the next checkout reconnects. Unhandled, the event would crash the process.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}

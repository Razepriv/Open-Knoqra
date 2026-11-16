/** Postgres SQLSTATEs for a transaction aborted only because of a concurrent one. */
const TRANSIENT_CODES: readonly string[] = [
  '40P01', // deadlock_detected
  '40001', // serialization_failure
];

/**
 * True when a deadlock or serialization failure is anywhere in the `cause` chain. Drizzle wraps
 * the pg `DatabaseError` (which carries `code`) in a `DrizzleQueryError` as its `cause`.
 */
export function isTransientConflict(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const code = (e as Error & { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_CODES.includes(code)) return true;
  }
  return false;
}

/**
 * Runs `transaction` and, when Postgres aborted it as a deadlock or serialization failure, runs
 * it once more. Postgres rolled the first attempt back, so `transaction` must be a whole
 * transaction (a `withTenant` call) that is safe to start again from scratch.
 */
export async function retryOnConflict<T>(transaction: () => Promise<T>): Promise<T> {
  try {
    return await transaction();
  } catch (error) {
    if (!isTransientConflict(error)) throw error;
    return transaction();
  }
}

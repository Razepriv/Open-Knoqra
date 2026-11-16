// The one-line machine summary reports carry: no hostname, no paths.
import os from 'node:os';

/** Platform, CPU count and Node version; plus the PostgreSQL version when it is known. */
export function machineSummary(postgres?: string): string {
  const base = `${os.platform()}, ${os.cpus().length} CPUs, Node ${process.versions.node}`;
  return postgres === undefined ? base : `${base}, PostgreSQL ${postgres}`;
}

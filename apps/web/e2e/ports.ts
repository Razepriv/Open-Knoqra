/**
 * Dev and E2E ports. Defaults match local development (Vite 5173, wrangler 8787).
 * Parallel worktrees override them with KNOQRA_WEB_PORT / KNOQRA_API_PORT so two E2E runs never
 * collide; apps/api/.dev.vars must then set BETTER_AUTH_URL=http://localhost:<KNOQRA_WEB_PORT>.
 */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535, got "${raw}".`);
  }
  return value;
}

export const WEB_PORT: number = port('KNOQRA_WEB_PORT', 5173);
export const API_PORT: number = port('KNOQRA_API_PORT', 8787);
export const WEB_ORIGIN: string = `http://localhost:${WEB_PORT}`;
export const API_ORIGIN: string = `http://localhost:${API_PORT}`;

// Where perf:load sends its requests (Ruling L-a):
//   inprocess (default): the Hono app called in-process under Node; carries the p95 gate.
//   wrangler: local wrangler dev over HTTP; informational, no gate.
//   remote: an already-deployed Worker over HTTPS (a staging Worker on a seeded perf branch);
//           carries the p95 gate, signs in once and leaves the sign-in scenario out of the mix.
import { flagValue } from '../config';
import type { Mix } from './runner';

export const TARGET_KINDS = ['inprocess', 'wrangler', 'remote'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export type LoadTarget =
  | { kind: 'inprocess' }
  | { kind: 'wrangler' }
  | { kind: 'remote'; apiOrigin: string; webOrigin: string };

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** A remote host must name one of these, so nobody load-tests production by accident. */
const NON_PRODUCTION_MARKERS = ['staging', 'preview', 'perf'];

/** True when the target's p95 must stay within budget; wrangler is informational only. */
export function isGated(target: LoadTarget): boolean {
  return target.kind !== 'wrangler';
}

/**
 * Ruling L-b: inprocess gates latency at full data scale with one user (all users share one Node
 * event loop, so more users measure that loop, not the API); remote gates throughput on real
 * infrastructure with 10. `--vus` overrides either.
 */
export function defaultVus(target: LoadTarget): number {
  return target.kind === 'inprocess' ? 1 : 10;
}

/**
 * Ruling L-c: inprocess fires a scenario's requests one at a time, so one user is one request in
 * flight; remote and wrangler fire them in parallel, as a browser does.
 */
export function isSequential(target: LoadTarget): boolean {
  return target.kind === 'inprocess';
}

/** One report line with the user count and why it was chosen. */
export function describeUsers(target: LoadTarget, vus: number): string {
  const users = `${vus} virtual user${vus === 1 ? '' : 's'}`;
  switch (target.kind) {
    case 'inprocess':
      return (
        `- Users: ${users}, one request at a time (Rulings L-b and L-c; default 1). This gates ` +
        'latency at full data scale. Every ' +
        'in-process user shares one Node event loop, so throughput is gated on staging with ' +
        '`--target remote` instead (go-live step 6a).'
      );
    case 'remote':
      return `- Users: ${users} (Ruling L-b; default 10), each firing a scenario's requests in parallel as a browser does. This gates throughput on real infrastructure.`;
    case 'wrangler':
      return `- Users: ${users} (default 10), each firing a scenario's requests in parallel. Informational only.`;
  }
}

/**
 * Validates one remote origin: an absolute https URL (http only for localhost) with no
 * credentials, path, query or fragment, whose host names staging, preview or perf unless `force`.
 * Returns the bare origin.
 */
export function parseRemoteOrigin(
  flag: string,
  raw: string | undefined,
  force: boolean,
): Result<string> {
  if (raw === undefined || raw === '' || raw.startsWith('--')) {
    return { ok: false, error: `--target remote needs ${flag} <https url>` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `${flag} is not a URL` };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { ok: false, error: `${flag} must be https (http only for localhost)` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: `${flag} must not carry credentials` };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, error: `${flag} must be an origin, with no path or query` };
  }
  const host = url.hostname.toLowerCase();
  if (!force && !NON_PRODUCTION_MARKERS.some((m) => host.includes(m))) {
    return {
      ok: false,
      error: `${flag} host ${host} names none of ${NON_PRODUCTION_MARKERS.join(', ')}; pass --force if it is not production`,
    };
  }
  return { ok: true, value: url.origin };
}

/** Reads `--target` (default inprocess) and, for remote, `--api-origin` and `--web-origin`. */
export function parseLoadTarget(argv: string[], force: boolean): Result<LoadTarget> {
  const given = argv.some((a) => a === '--target' || a.startsWith('--target='));
  const raw = flagValue(argv, '--target') ?? (given ? '' : 'inprocess');
  if (!(TARGET_KINDS as readonly string[]).includes(raw)) {
    return { ok: false, error: `--target must be one of ${TARGET_KINDS.join(', ')}` };
  }
  const kind = raw as TargetKind;
  const apiRaw = flagValue(argv, '--api-origin');
  const webRaw = flagValue(argv, '--web-origin');
  if (kind !== 'remote') {
    if (apiRaw !== undefined || webRaw !== undefined) {
      return { ok: false, error: '--api-origin and --web-origin need --target remote' };
    }
    return { ok: true, value: { kind } };
  }
  const api = parseRemoteOrigin('--api-origin', apiRaw, force);
  if (!api.ok) return api;
  const web = parseRemoteOrigin('--web-origin', webRaw, force);
  if (!web.ok) return web;
  return { ok: true, value: { kind, apiOrigin: api.value, webOrigin: web.value } };
}

const SIGN_IN_PATH = '/api/auth/sign-in';

/**
 * The mix a target runs. Remote leaves out every scenario that signs in (staging rate-limits
 * sign-in per IP) and rescales the remaining weights to sum to 100.
 */
export function effectiveMix(mix: Mix, target: LoadTarget): Mix {
  if (target.kind !== 'remote') return mix;
  const kept = mix.scenarios.filter(
    (s) => s.name !== 'sign-in' && !s.requests.some((r) => r.path.startsWith(SIGN_IN_PATH)),
  );
  const total = kept.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return { scenarios: [] };
  return { scenarios: kept.map((s) => ({ ...s, weight: (s.weight * 100) / total })) };
}

/** Host only, for the report: never a full URL. */
function hostOf(origin: string): string {
  return new URL(origin).host;
}

/** One report line naming the target and what it measures. */
export function describeTarget(target: LoadTarget): string {
  switch (target.kind) {
    case 'inprocess':
      return (
        '- Target: inprocess. The real Hono app called in-process under Node against the perf ' +
        'database as knoqra_app: it measures routing, middleware, auth and SQL, and leaves out ' +
        'the Workers runtime and the network.'
      );
    case 'wrangler':
      return (
        '- Target: wrangler (informational, no gate). Local wrangler dev over HTTP handles ' +
        'requests one at a time with a floor of about 50 ms each, so under load this measures ' +
        'its queue, not the API.'
      );
    case 'remote':
      return (
        `- Target: remote, API host ${hostOf(target.apiOrigin)}, web host ${hostOf(target.webOrigin)}. ` +
        'A deployed Worker over HTTPS: it includes the Workers runtime, Hyperdrive and the network ' +
        'from this machine. Signs in once; the sign-in scenario is left out and the other weights ' +
        'rescaled, because staging rate-limits sign-in.'
      );
  }
}

// A thin Cloudflare API v4 client over an injected `fetch`. In dry-run mode only GET requests are
// sent; every other request is reported and skipped.

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export class CloudflareError extends Error {
  constructor(message, status, errors = []) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

function describe(json, status) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const text = errors.map((e) => [e.code, e.message].filter(Boolean).join(' ')).join('; ');
  return text || `HTTP ${status}`;
}

/**
 * @param {object} options
 * @param {string} options.token          Cloudflare API token
 * @param {typeof fetch} options.fetch
 * @param {boolean} [options.dryRun]      skip (but report) every request that is not a GET
 * @param {(method: string, path: string, sent: boolean) => void} [options.onRequest]
 */
export function createCloudflare({ token, fetch, dryRun = false, onRequest }) {
  async function call(method, path, body) {
    const send = method === 'GET' || !dryRun;
    onRequest?.(method, path, send);
    if (!send) return { success: true, result: null, dryRun: true };
    const response = await fetch(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    let json;
    try {
      json = await response.json();
    } catch {
      throw new CloudflareError(`${method} ${path}: HTTP ${response.status}`, response.status);
    }
    if (!json?.success) {
      throw new CloudflareError(
        `${method} ${path}: ${describe(json, response.status)}`,
        response.status,
        json?.errors,
      );
    }
    return json;
  }

  return {
    call,
    /** The accounts this token can use: [{ id, name }]. */
    async listAccounts() {
      const json = await call('GET', '/accounts?per_page=50');
      return (json.result ?? []).map((a) => ({ id: a.id, name: a.name }));
    },
    /** The zone (domain) names this token can see. */
    async listZones() {
      const json = await call('GET', '/zones?per_page=50');
      return (json.result ?? []).map((z) => z.name);
    },
    /** The account's workers.dev subdomain (`example` for example.workers.dev), or null. */
    async workersSubdomain(accountId) {
      try {
        const json = await call('GET', `/accounts/${accountId}/workers/subdomain`);
        return json.result?.subdomain || null;
      } catch (error) {
        if (error instanceof CloudflareError && error.status === 404) return null;
        throw error;
      }
    },
    /** The Hyperdrive config with this name, or null. */
    async findHyperdrive(accountId, name) {
      const json = await call('GET', `/accounts/${accountId}/hyperdrive/configs`);
      return (json.result ?? []).find((c) => c.name === name) ?? null;
    },
    /** Creates a Hyperdrive config and returns its id (null in dry-run mode). */
    async createHyperdrive(accountId, body) {
      const json = await call('POST', `/accounts/${accountId}/hyperdrive/configs`, body);
      return json.result?.id ?? null;
    },
    async updateHyperdrive(accountId, id, body) {
      await call('PUT', `/accounts/${accountId}/hyperdrive/configs/${id}`, body);
    },
    /** The names of the account's queues. */
    async listQueues(accountId) {
      const json = await call('GET', `/accounts/${accountId}/queues?per_page=100`);
      return (json.result ?? []).map((q) => q.queue_name);
    },
    async createQueue(accountId, name) {
      await call('POST', `/accounts/${accountId}/queues`, { queue_name: name });
    },
    /** The names of the account's R2 buckets. */
    async listBuckets(accountId) {
      const json = await call('GET', `/accounts/${accountId}/r2/buckets?per_page=1000`);
      return (json.result?.buckets ?? []).map((b) => b.name);
    },
    async createBucket(accountId, name) {
      await call('POST', `/accounts/${accountId}/r2/buckets`, { name });
    },
  };
}

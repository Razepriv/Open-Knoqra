/**
 * A non-2xx provider response, or a response KNOQRA could not read (`invalid_response`). The
 * message carries the status and a safe code only: never the provider's own text, which can echo
 * request details. Each provider's error extends this, so callers need not know which one failed.
 */
export class ProviderApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`${provider} API error: status ${status}, code ${code}`);
    this.name = 'ProviderApiError';
  }
}

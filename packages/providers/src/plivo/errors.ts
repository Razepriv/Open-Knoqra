import { ProviderApiError } from '../provider-error';

/**
 * A non-2xx Plivo response, or one KNOQRA could not read (`invalid_response`). Plivo's error body
 * is free text that can echo request details, so it is never kept: the code is `http_<status>`.
 */
export class PlivoApiError extends ProviderApiError {
  constructor(status: number, code: string = `http_${status}`) {
    super('Plivo', status, code);
    this.name = 'PlivoApiError';
  }
}

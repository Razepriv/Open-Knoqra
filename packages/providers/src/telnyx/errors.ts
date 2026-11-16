import { ProviderApiError } from '../provider-error';

/** A non-2xx Telnyx response. The message carries the status and Telnyx error code only. */
export class TelnyxApiError extends ProviderApiError {
  constructor(status: number, code: string) {
    super('Telnyx', status, code);
    this.name = 'TelnyxApiError';
  }
}

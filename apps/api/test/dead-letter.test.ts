import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '../src/observability/report';
import { handleDeadLetters } from '../src/queue/dead-letter';

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

function batchOf(rawEventId: string) {
  const message = { body: { rawEventId }, ack: vi.fn(), retry: vi.fn() };
  const batch = {
    queue: 'knoqra-provider-events-dlq',
    messages: [message],
  } as unknown as MessageBatch<{ rawEventId: string }>;
  return { batch, message };
}

describe('handleDeadLetters', () => {
  it('retries and reports a message it could not mark', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = vi.fn();
    setErrorReporter(reporter);
    // Nothing listens on port 1: every query fails.
    const broken = {
      ...env,
      DATABASE_URL: 'postgres://knoqra_app:knoqra_app@127.0.0.1:1/knoqra',
    } as typeof env;
    const { batch, message } = batchOf(`pe_dlq_${crypto.randomUUID()}`);

    await handleDeadLetters(batch, broken);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: 'queue' }),
    );
  });
});

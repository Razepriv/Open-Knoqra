import { describe, expect, it } from 'vitest';
import { CRON_JOBS } from '../src/cron/jobs';
import wranglerText from '../wrangler.jsonc?raw';

/** wrangler.jsonc allows whole-line // comments; strip them, then parse the top-level crons. */
function topLevelCrons(): string[] {
  const text = wranglerText
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const config = JSON.parse(text) as { triggers?: { crons?: string[] } };
  return config.triggers?.crons ?? [];
}

describe('CRON_JOBS', () => {
  it('declares the planned names, crons and lateness limits', () => {
    expect(
      CRON_JOBS.map((j) => ({
        name: j.name,
        cron: j.cron,
        maxIntervalMinutes: j.maxIntervalMinutes,
      })),
    ).toEqual([
      { name: 'stale-call-sweep', cron: '*/5 * * * *', maxIntervalMinutes: 5 },
      { name: 'balance-poll', cron: '*/30 * * * *', maxIntervalMinutes: 90 },
      { name: 'ledger-reconcile', cron: '15 3 * * *', maxIntervalMinutes: 1500 },
    ]);
  });

  it('has every cron registered in wrangler.jsonc triggers.crons', () => {
    const crons = topLevelCrons();
    for (const job of CRON_JOBS) expect(crons).toContain(job.cron);
  });
});

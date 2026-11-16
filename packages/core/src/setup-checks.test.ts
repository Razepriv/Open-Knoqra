import { describe, expect, it } from 'vitest';
import {
  evaluateSetupChecks,
  SETUP_CHECK_IDS,
  type SetupCheckId,
  type SetupFacts,
} from './setup-checks';

const base: SetupFacts = {
  provider: 'telnyx',
  credentialStored: true,
  lastPoll: 'ok',
  numbersSynced: 1,
  assignedForCalls: true,
  webhookKeyConfigured: true,
  lastWebhookAt: new Date('2026-11-12T10:00:00Z'),
  tenDlc: 'registered',
  whatsapp: 'approved',
};

const TEN_DLC = {
  kind: 'external',
  href: '/inbox',
  label: 'Enable SMS in the Inbox',
};
const WA = {
  kind: 'external',
  href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
  label: 'Start Meta approval',
};
const CONNECT = { kind: 'wizard', step: 'connect' };
const NUMBER = { kind: 'wizard', step: 'number' };
const TEST_CALL = { kind: 'wizard', step: 'test_call' };

type Row = [string, Partial<SetupFacts>, SetupCheckId, string, unknown];

const rows: Row[] = [
  ['credential not stored', { credentialStored: false }, 'credential', 'fail', CONNECT],
  ['credential rejected', { lastPoll: 'auth_failed' }, 'credential', 'fail', CONNECT],
  ['credential unpolled', { lastPoll: null }, 'credential', 'pending', CONNECT],
  ['credential unavailable', { lastPoll: 'unavailable' }, 'credential', 'pending', CONNECT],
  ['credential ok', {}, 'credential', 'pass', CONNECT],
  ['credential fake', { provider: 'fake', lastPoll: null }, 'credential', 'pass', CONNECT],
  ['no numbers', { numbersSynced: 0, assignedForCalls: false }, 'number', 'fail', NUMBER],
  ['numbers unassigned', { assignedForCalls: false }, 'number', 'pending', NUMBER],
  ['number ok', {}, 'number', 'pass', NUMBER],
  [
    'webhook key missing',
    { webhookKeyConfigured: false },
    'webhook',
    'fail',
    {
      kind: 'external',
      href: expect.stringContaining('docs/self-host.md'),
      label: 'Set TELNYX_PUBLIC_KEY',
    },
  ],
  ['webhook none yet', { lastWebhookAt: null }, 'webhook', 'pending', TEST_CALL],
  ['webhook ok', {}, 'webhook', 'pass', TEST_CALL],
  [
    'webhook fake no key',
    { provider: 'fake', webhookKeyConfigured: false },
    'webhook',
    'pass',
    TEST_CALL,
  ],
  ['10dlc registered', {}, 'ten_dlc', 'pass', TEN_DLC],
  ['10dlc not required', { tenDlc: 'not_required' }, 'ten_dlc', 'pass', TEN_DLC],
  ['10dlc pending', { tenDlc: 'pending' }, 'ten_dlc', 'pending', TEN_DLC],
  ['10dlc none', { tenDlc: 'none' }, 'ten_dlc', 'fail', TEN_DLC],
  ['10dlc failed', { tenDlc: 'failed' }, 'ten_dlc', 'fail', TEN_DLC],
  ['whatsapp approved', {}, 'whatsapp', 'pass', WA],
  ['whatsapp pending', { whatsapp: 'pending' }, 'whatsapp', 'pending', WA],
  ['whatsapp none', { whatsapp: 'none' }, 'whatsapp', 'fail', WA],
  ['whatsapp rejected', { whatsapp: 'rejected' }, 'whatsapp', 'fail', WA],
];

describe('evaluateSetupChecks', () => {
  it('returns all checks in order with titles', () => {
    const checks = evaluateSetupChecks(base);
    expect(checks.map((c) => c.id)).toEqual([...SETUP_CHECK_IDS]);
    expect(checks.map((c) => c.title)).toEqual([
      'Phone provider credential',
      'Number assigned',
      'Webhook reachable',
      '10DLC registration',
      'WhatsApp approval',
    ]);
  });

  it.each(rows)('%s', (_name, patch, id, status, fix) => {
    const check = evaluateSetupChecks({ ...base, ...patch }).find((c) => c.id === id);
    expect(check?.status).toBe(status);
    expect(check?.fix).toEqual(fix);
  });

  it('uses the specified details', () => {
    const detail = (patch: Partial<SetupFacts>, id: SetupCheckId) =>
      evaluateSetupChecks({ ...base, ...patch }).find((c) => c.id === id)?.detail;
    expect(detail({ lastPoll: 'auth_failed' }, 'credential')).toBe(
      'Your phone provider rejected the key',
    );
    expect(detail({ provider: 'fake', lastPoll: null }, 'credential')).toBe(
      'Saved. Calls use the fake provider in development.',
    );
    expect(detail({ lastWebhookAt: null }, 'webhook')).toBe(
      'No webhook received yet. Place a test call.',
    );
    expect(detail({ tenDlc: 'none' }, 'ten_dlc')).toBe(
      'Needs a live phone provider account. US SMS sending waits for US texting registration.',
    );
    expect(detail({ whatsapp: 'none' }, 'whatsapp')).toBe(
      'Needs Meta approval of your WhatsApp Business account.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  type ComposerState,
  canMarkApproved,
  composerCopy,
  composerLink,
  liveSenderErrorCopy,
  liveSenderStatus,
  senderSummary,
  showLiveSender,
  statusMeta,
  threadDayGroups,
  threadState,
  windowLabel,
  windowPercent,
} from './inbox-format';

const NOW = new Date('2026-11-12T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('windowLabel', () => {
  it('counts hours and minutes while the window is open', () => {
    expect(windowLabel(at(23 * HOUR + 59 * MIN), NOW)).toBe('23 h 59 m left');
  });

  it('shows only minutes under one hour', () => {
    expect(windowLabel(at(45 * MIN), NOW)).toBe('45 m left');
  });

  it('names the weekday and 24 h time once the window has closed', () => {
    // 2026-11-10 is a Tuesday.
    expect(windowLabel('2026-11-10T14:10:00Z', NOW, 'UTC')).toBe('Closed Tue 14:10');
  });

  it('formats the closing time in the given zone', () => {
    expect(windowLabel('2026-11-10T14:10:00Z', NOW, 'America/Chicago')).toBe('Closed Tue 08:10');
  });

  it('treats the exact expiry moment as closed', () => {
    expect(windowLabel(NOW.toISOString(), NOW, 'UTC')).toBe('Closed Thu 12:00');
  });

  it('says there is no inbound message yet for null', () => {
    expect(windowLabel(null, NOW)).toBe('No inbound yet');
  });
});

describe('windowPercent', () => {
  it('is 100 for a full 24 h and 0 once closed', () => {
    expect(windowPercent(at(24 * HOUR), NOW)).toBe(100);
    expect(windowPercent(at(-HOUR), NOW)).toBe(0);
    expect(windowPercent(null, NOW)).toBe(0);
  });

  it('is the remaining share of 24 h, never above 100', () => {
    expect(windowPercent(at(12 * HOUR), NOW)).toBe(50);
    expect(windowPercent(at(30 * HOUR), NOW)).toBe(100);
  });
});

describe('statusMeta', () => {
  it.each([
    ['queued', 'SENDING…'],
    ['sent', 'SENT'],
    ['delivered', 'DELIVERED'],
    ['read', 'READ'],
    ['received', 'RECEIVED'],
  ] as const)('%s becomes %s', (status, expected) => {
    expect(statusMeta(status, null)).toBe(expected);
  });

  it('adds the error message to a failure', () => {
    expect(statusMeta('failed', { code: 'x', message: 'Number unreachable' })).toBe(
      'FAILED · Number unreachable',
    );
  });

  it('is plain FAILED when no error was recorded', () => {
    expect(statusMeta('failed', null)).toBe('FAILED');
  });
});

const composer = (
  mode: ComposerState['mode'],
  reason: ComposerState['reason'],
  windowExpiresAt: string | null = null,
): ComposerState => ({ mode, reason, windowExpiresAt });

describe('threadState', () => {
  it('shows the window for a free WhatsApp thread', () => {
    expect(threadState('whatsapp', composer('free', 'ok', at(23 * HOUR + 59 * MIN)), NOW)).toEqual({
      label: '23 h 59 m left',
      tone: 'ok',
    });
  });

  it('shows Ready for a free SMS thread', () => {
    expect(threadState('sms', composer('free', 'ok'), NOW)).toEqual({
      label: 'Ready',
      tone: 'ok',
    });
  });

  it('warns that a template is needed', () => {
    expect(threadState('whatsapp', composer('template_only', 'window_closed'), NOW)).toEqual({
      label: 'Template needed',
      tone: 'warn',
    });
  });

  it('warns that sending is paused', () => {
    expect(threadState('sms', composer('paused', 'registration_pending'), NOW)).toEqual({
      label: 'Sending paused',
      tone: 'warn',
    });
  });

  it.each([
    ['opted_out', 'Opted out'],
    ['do_not_contact', 'Do not contact'],
    ['revoked', 'Consent revoked'],
    ['consent_required', 'Needs consent'],
  ] as const)('blocked for %s reads %s', (reason, label) => {
    expect(threadState('sms', composer('blocked', reason), NOW)).toEqual({ label, tone: 'bad' });
  });
});

describe('composerCopy', () => {
  it('explains a pending SMS registration', () => {
    expect(composerCopy('sms', composer('paused', 'registration_pending'))).toEqual({
      title: 'SMS sending paused · 10DLC',
      body: 'Inbound SMS is received and kept. Outbound starts when 10DLC is approved.',
    });
  });

  it('explains a pending WhatsApp registration', () => {
    expect(composerCopy('whatsapp', composer('paused', 'registration_pending'))).toEqual({
      title: 'WhatsApp sending paused · Meta approval',
      body: 'Inbound WhatsApp is received and kept. Outbound starts when Meta approves your business.',
    });
  });

  it('names the channel when no sender is connected', () => {
    const body = 'Connect a number in Numbers to send. Inbound replies still arrive.';
    expect(composerCopy('sms', composer('paused', 'no_sender'))).toEqual({
      title: 'No SMS sender connected',
      body,
    });
    expect(composerCopy('whatsapp', composer('paused', 'no_sender'))).toEqual({
      title: 'No WhatsApp sender connected',
      body,
    });
  });

  it('covers a rejected registration and live sending being off', () => {
    expect(composerCopy('sms', composer('paused', 'registration_rejected'))).toEqual({
      title: 'Registration rejected',
      body: 'Fix the registration in Numbers before sending.',
    });
    expect(composerCopy('sms', composer('paused', 'live_disabled'))).toEqual({
      title: 'Live sending is off',
      body: 'Sending stays off until US texting registration (SMS) or WhatsApp approval is confirmed.',
    });
  });

  it('covers a closed WhatsApp window', () => {
    expect(composerCopy('whatsapp', composer('template_only', 'window_closed'))).toEqual({
      title: 'Window closed · templates only',
      body: "WhatsApp allows only approved templates more than 24 hours after the contact's last message.",
    });
  });

  it('covers every blocked reason', () => {
    expect(composerCopy('sms', composer('blocked', 'opted_out'))).toEqual({
      title: 'Opted out · messages blocked',
      body: 'They replied STOP. Messages stay blocked until they reply START.',
    });
    expect(composerCopy('sms', composer('blocked', 'do_not_contact'))).toEqual({
      title: 'Do not contact · messages blocked',
      body: 'Do not contact. Policy, not a task.',
    });
    expect(composerCopy('sms', composer('blocked', 'revoked'))).toEqual({
      title: 'Consent revoked · messages blocked',
      body: 'Record new consent on the contact before messaging.',
    });
    expect(composerCopy('whatsapp', composer('blocked', 'consent_required'))).toEqual({
      title: 'Needs consent before messaging',
      body: 'Record that this contact agreed to receive WhatsApp before you send.',
    });
    expect(composerCopy('sms', composer('blocked', 'consent_required')).body).toBe(
      'Record that this contact agreed to receive SMS before you send.',
    );
  });

  it('has no copy for a free composer', () => {
    expect(composerCopy('sms', composer('free', 'ok'))).toEqual({ title: '', body: '' });
  });
});

describe('threadDayGroups', () => {
  const item = (occurredAt: string) => ({ occurredAt });

  it('labels an older day like the design, MON 9 NOV, whatever the browser locale', () => {
    // 2026-11-09 is a Monday.
    const groups = threadDayGroups([item('2026-11-09T10:00:00Z')], NOW, 'UTC');
    expect(groups.map((g) => g.label)).toEqual(['MON 9 NOV']);
  });

  it('keeps TODAY and YESTERDAY, and groups items oldest first by day', () => {
    const groups = threadDayGroups(
      [
        item('2026-11-09T10:00:00Z'),
        item('2026-11-11T09:00:00Z'),
        item('2026-11-12T08:00:00Z'),
        item('2026-11-12T09:30:00Z'),
      ],
      NOW,
      'UTC',
    );
    expect(groups.map((g) => [g.label, g.events.length])).toEqual([
      ['MON 9 NOV', 1],
      ['YESTERDAY', 1],
      ['TODAY', 2],
    ]);
  });
});

describe('composerLink', () => {
  it('links live_disabled to the Voice section of Settings, where Telnyx is connected', () => {
    expect(composerLink(composer('paused', 'live_disabled'))).toEqual({
      label: 'Set up live sending',
      to: '/settings',
      hash: 'voice-heading',
    });
  });

  it('has no link for other states', () => {
    expect(composerLink(composer('paused', 'registration_pending'))).toBeNull();
    expect(composerLink(composer('free', 'ok'))).toBeNull();
    expect(composerLink(composer('blocked', 'opted_out'))).toBeNull();
  });
});

describe('senderSummary', () => {
  const sender = (
    provider: 'fake' | 'telnyx',
    liveEnabled: boolean,
    registrationStatus: 'not_started' | 'pending' | 'approved' | 'rejected' = 'approved',
  ) => ({
    id: 'cc_1',
    channel: 'sms' as const,
    provider,
    address: provider === 'fake' ? 'sandbox:abc' : '+12025550150',
    registrationStatus,
    sandbox: provider === 'fake',
    liveEnabled,
  });

  it('names the sandbox and says nothing leaves KNOQRA', () => {
    expect(senderSummary(sender('fake', true))).toEqual({
      title: 'Sandbox sender',
      note: 'Messages stay inside KNOQRA. Nothing reaches a real phone.',
    });
  });

  it('marks a live Telnyx sender', () => {
    expect(senderSummary(sender('telnyx', true))).toEqual({
      title: '+12025550150',
      note: 'Live',
    });
  });

  it('says when a Telnyx sender is not live yet', () => {
    expect(senderSummary(sender('telnyx', false))).toEqual({
      title: '+12025550150',
      note: 'Live sending off',
    });
    expect(senderSummary(sender('telnyx', false, 'pending')).note).toBe('Live sending off');
  });

  it('says Live only once the registration is approved', () => {
    expect(senderSummary(sender('telnyx', true, 'pending')).note).toBe('Registration pending');
    expect(senderSummary(sender('telnyx', true, 'not_started')).note).toBe(
      'Registration not started',
    );
    expect(senderSummary(sender('telnyx', true, 'rejected')).note).toBe('Registration rejected');
  });
});

describe('showLiveSender', () => {
  const live = { role: 'owner', hasConnection: true, liveAvailable: true };

  it('shows for an owner or admin with a Telnyx connection on a Telnyx deployment', () => {
    expect(showLiveSender(live)).toBe(true);
    expect(showLiveSender({ ...live, role: 'admin' })).toBe(true);
  });

  it('hides off a Telnyx deployment, without a connection, or for a member', () => {
    expect(showLiveSender({ ...live, liveAvailable: false })).toBe(false);
    expect(showLiveSender({ ...live, hasConnection: false })).toBe(false);
    expect(showLiveSender({ ...live, role: 'member' })).toBe(false);
    expect(showLiveSender({ ...live, role: undefined })).toBe(false);
  });
});

describe('canMarkApproved', () => {
  const template = (over: Record<string, unknown>) => ({
    id: 'mt_1',
    name: 'Welcome',
    channel: 'whatsapp' as const,
    body: 'Hi',
    placeholders: [],
    approvalStatus: 'pending' as const,
    archivedAt: null,
    createdAt: NOW.toISOString(),
    whatsappTemplateName: 'welcome',
    whatsappLanguage: 'en_US',
    ...over,
  });

  it('is true for a pending WhatsApp template with its Meta fields', () => {
    expect(canMarkApproved(template({}))).toBe(true);
  });

  it('is false when approved, SMS, or missing a Meta field', () => {
    expect(canMarkApproved(template({ approvalStatus: 'approved' }))).toBe(false);
    expect(canMarkApproved(template({ channel: 'sms' }))).toBe(false);
    expect(canMarkApproved(template({ whatsappLanguage: null }))).toBe(false);
  });
});

describe('liveSenderErrorCopy', () => {
  it('uses our wording per status', () => {
    expect(liveSenderErrorCopy(new ApiError(422, 'x', 'validation_error'))).toBe(
      'Connect your phone provider in Settings first.',
    );
    expect(liveSenderErrorCopy(new ApiError(409, 'x'))).toBe(
      "This number can't be used as a sender.",
    );
    expect(liveSenderErrorCopy(new ApiError(502, 'x'))).toBe(
      'Your phone provider could not be reached. Try again in a moment.',
    );
    expect(liveSenderErrorCopy(new ApiError(403, 'x'))).toBe(
      'Only owners and admins can change senders.',
    );
    expect(liveSenderErrorCopy(new ApiError(400, 'x'))).toBe(
      'Add a caller ID to your phone connection in Settings first.',
    );
    expect(liveSenderErrorCopy(new Error('boom'))).toBe(
      'Something went wrong. Try again in a moment.',
    );
  });

  it('tells the 422 refusals apart by code', () => {
    expect(liveSenderErrorCopy(new ApiError(422, 'x', 'number_not_owned'))).toBe(
      "This number isn't in your connected account.",
    );
    expect(liveSenderErrorCopy(new ApiError(422, 'x', 'provider_auth'))).toBe(
      'The saved API key was not accepted. Check it in Settings.',
    );
    expect(liveSenderErrorCopy(new ApiError(422, 'x', 'not_configured'))).toBe(
      "Live sending isn't available on this deployment.",
    );
    expect(liveSenderErrorCopy(new ApiError(422, 'x', 'number_not_synced'))).toBe(
      'Sync your numbers in Numbers, then try again with an active number.',
    );
  });

  it('asks for a retry when the Telnyx connection changed while saving', () => {
    expect(liveSenderErrorCopy(new ApiError(409, 'x', 'credential_changed'))).toBe(
      'Your phone connection changed. Try again.',
    );
  });
});

describe('liveSenderStatus', () => {
  it('derives the SMS status from Numbers, with no status to set', () => {
    expect(liveSenderStatus('sms')).toEqual({
      settable: false,
      note: 'Registration status comes from Numbers.',
    });
  });

  it('lets an owner set the WhatsApp status until Telnyx reports it', () => {
    expect(liveSenderStatus('whatsapp')).toEqual({
      settable: true,
      note: 'Set it to Approved once WhatsApp approves this number.',
    });
  });
});

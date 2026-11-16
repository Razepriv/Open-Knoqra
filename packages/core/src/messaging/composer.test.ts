import { describe, expect, it } from 'vitest';
import type { PermissionStatus } from '../consent';
import { type ComposerState, composerState, WHATSAPP_WINDOW_MS } from './composer';

const now = new Date('2026-01-10T12:00:00.000Z');
const live = { registrationStatus: 'approved', liveEnabled: true } as const;
const inbound = (ms: number) => new Date(now.getTime() - ms);

type Input = Parameters<typeof composerState>[0];
const base: Input = {
  channel: 'sms',
  consent: 'granted',
  sender: live,
  lastInboundAt: null,
  now,
};

describe('composerState precedence', () => {
  const cases: [string, Partial<Input>, Pick<ComposerState, 'mode' | 'reason'>][] = [
    ['revoked consent', { consent: 'revoked' }, { mode: 'blocked', reason: 'revoked' }],
    ['opted out', { consent: 'opted_out' }, { mode: 'blocked', reason: 'opted_out' }],
    [
      'do not contact',
      { consent: 'do_not_contact' },
      { mode: 'blocked', reason: 'do_not_contact' },
    ],
    ['unknown consent', { consent: undefined }, { mode: 'blocked', reason: 'consent_required' }],
    [
      'opted out beats paused sender',
      { consent: 'opted_out', sender: null },
      { mode: 'blocked', reason: 'opted_out' },
    ],
    ['no sender', { sender: null }, { mode: 'paused', reason: 'no_sender' }],
    [
      'not started',
      { sender: { registrationStatus: 'not_started', liveEnabled: true } },
      { mode: 'paused', reason: 'registration_pending' },
    ],
    [
      'pending',
      { sender: { registrationStatus: 'pending', liveEnabled: true } },
      { mode: 'paused', reason: 'registration_pending' },
    ],
    [
      'rejected',
      { sender: { registrationStatus: 'rejected', liveEnabled: true } },
      { mode: 'paused', reason: 'registration_rejected' },
    ],
    [
      'live disabled',
      { sender: { registrationStatus: 'approved', liveEnabled: false } },
      { mode: 'paused', reason: 'live_disabled' },
    ],
    [
      'pending beats live disabled',
      { sender: { registrationStatus: 'pending', liveEnabled: false } },
      { mode: 'paused', reason: 'registration_pending' },
    ],
    [
      'whatsapp without inbound',
      { channel: 'whatsapp' },
      { mode: 'template_only', reason: 'window_closed' },
    ],
    [
      'whatsapp inside window',
      { channel: 'whatsapp', lastInboundAt: inbound(1000) },
      { mode: 'free', reason: 'ok' },
    ],
    ['sms ok', {}, { mode: 'free', reason: 'ok' }],
  ];
  it.each(cases)('%s', (_name, patch, expected) => {
    expect(composerState({ ...base, ...patch })).toMatchObject(expected);
  });
});

describe('composerState WhatsApp window', () => {
  const wa: Input = { ...base, channel: 'whatsapp' };
  it('is free at +23h59m59s', () => {
    const last = inbound(WHATSAPP_WINDOW_MS - 1000);
    const s = composerState({ ...wa, lastInboundAt: last });
    expect(s.mode).toBe('free');
    expect(s.windowExpiresAt).toEqual(new Date(last.getTime() + WHATSAPP_WINDOW_MS));
  });
  it('is template_only at exactly +24h', () => {
    const s = composerState({ ...wa, lastInboundAt: inbound(WHATSAPP_WINDOW_MS) });
    expect(s).toMatchObject({ mode: 'template_only', reason: 'window_closed' });
  });
  it('has a null expiry without an inbound', () => {
    expect(composerState(wa).windowExpiresAt).toBeNull();
  });
  it('sets windowExpiresAt even when blocked or paused', () => {
    const last = inbound(1000);
    const expiry = new Date(last.getTime() + WHATSAPP_WINDOW_MS);
    const blocked = composerState({
      ...wa,
      consent: 'opted_out' as PermissionStatus,
      lastInboundAt: last,
    });
    expect(blocked.mode).toBe('blocked');
    expect(blocked.windowExpiresAt).toEqual(expiry);
    const paused = composerState({ ...wa, sender: null, lastInboundAt: last });
    expect(paused.windowExpiresAt).toEqual(expiry);
  });
  it('never gives template_only or an expiry for SMS', () => {
    const s = composerState({ ...base, lastInboundAt: inbound(WHATSAPP_WINDOW_MS * 5) });
    expect(s).toEqual({ mode: 'free', reason: 'ok', windowExpiresAt: null });
  });
});

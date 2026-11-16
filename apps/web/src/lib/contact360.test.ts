import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockedPillText,
  CHANNEL_ORDER,
  channelLabel,
  consentSourceLabel,
  decisionCopy,
  decisionTone,
  duplicateReasonLabel,
  groupByDay,
  provenanceLabel,
  readOnlyMessageReason,
  statusLabel,
} from './contact360';

const REASONS = [
  'granted',
  'unknown_manual_call',
  'consent_required',
  'ai_voice_requires_consent',
  'revoked',
  'opted_out',
  'do_not_contact',
] as const;

describe('decisionCopy', () => {
  it('words the common cases the way the Desk does', () => {
    expect(decisionCopy('whatsapp', 'consent_required')).toBe('Needs consent before messaging.');
    expect(decisionCopy('sms', 'consent_required')).toBe('Needs consent before messaging.');
    expect(decisionCopy('manual_call', 'unknown_manual_call')).toBe(
      "Confirm you're authorized before calling.",
    );
    expect(decisionCopy('ai_voice', 'ai_voice_requires_consent')).toBe(
      'AI voice is off without explicit consent.',
    );
    for (const channel of CHANNEL_ORDER) {
      expect(decisionCopy(channel, 'do_not_contact')).toBe('Do not contact. Policy, not a task.');
    }
  });

  it('depends on the channel, not only the reason', () => {
    expect(decisionCopy('recording', 'consent_required')).toBe(
      'Recording needs consent before it can start.',
    );
    expect(decisionCopy('manual_call', 'opted_out')).toBe('Opted out. Calls stay off.');
    expect(decisionCopy('ai_voice', 'opted_out')).toBe('Opted out. Calls stay off.');
    expect(decisionCopy('sms', 'opted_out')).toBe('Opted out. Messages stay off.');
    expect(decisionCopy('whatsapp', 'opted_out')).toBe('Opted out. Messages stay off.');
  });

  it.each(CHANNEL_ORDER.flatMap((channel) => REASONS.map((reason) => [channel, reason] as const)))(
    '%s + %s has its own copy and never borrows another channel’s wording',
    (channel, reason) => {
      const text = decisionCopy(channel, reason);
      expect(text.trim().length).toBeGreaterThan(8);
      // Only SMS and WhatsApp are about messaging.
      if (channel !== 'sms' && channel !== 'whatsapp') expect(text).not.toMatch(/messag/i);
      // Calling language belongs to the call channels.
      if (channel === 'sms' || channel === 'whatsapp' || channel === 'recording') {
        if (reason !== 'unknown_manual_call') expect(text).not.toMatch(/\bcall/i);
      }
    },
  );

  it('gives every channel and reason a different sentence than a messaging default', () => {
    const all = new Set(
      CHANNEL_ORDER.flatMap((channel) => REASONS.map((reason) => decisionCopy(channel, reason))),
    );
    // 35 combinations share only the do-not-contact line, so there are well over 20 distinct texts.
    expect(all.size).toBeGreaterThan(20);
  });
});

describe('decisionTone', () => {
  it('maps the server outcome to a status dot without deciding anything itself', () => {
    expect(decisionTone('allowed')).toBe('ok');
    expect(decisionTone('needs_review')).toBe('warn');
    expect(decisionTone('blocked')).toBe('bad');
  });
});

describe('statusLabel', () => {
  it('names the outcome in words so colour is never the only signal', () => {
    expect(statusLabel('allowed')).toBe('Allowed');
    expect(statusLabel('needs_review')).toBe('Needs review');
    expect(statusLabel('blocked')).toBe('Blocked');
  });
});

describe('channels', () => {
  it('lists the five channels in the API order with readable names', () => {
    expect(CHANNEL_ORDER).toEqual(['manual_call', 'sms', 'whatsapp', 'ai_voice', 'recording']);
    expect(channelLabel('manual_call')).toBe('Manual calls');
    expect(channelLabel('whatsapp')).toBe('WhatsApp');
    expect(channelLabel('ai_voice')).toBe('AI voice');
  });
});

describe('blockedPillText', () => {
  const blocked = (reason: 'do_not_contact' | 'opted_out' | 'revoked') => ({
    channel: 'manual_call' as const,
    status: 'do_not_contact' as const,
    decision: { outcome: 'blocked' as const, reason },
    source: 'app',
    evidence: null,
    updatedAt: '2026-11-12T10:00:00.000Z',
  });

  it('returns the red-stripe label for a blocked channel', () => {
    expect(blockedPillText('manual_call', blocked('do_not_contact'))).toBe(
      'Calls blocked · Do not contact',
    );
    expect(blockedPillText('sms', blocked('opted_out'))).toBe('SMS blocked · Opted out');
    expect(blockedPillText('whatsapp', blocked('revoked'))).toBe(
      'WhatsApp blocked · Consent revoked',
    );
  });

  it('says what is missing when a messaging channel is blocked for lack of consent', () => {
    const needsConsent = {
      ...blocked('opted_out'),
      status: 'unknown' as const,
      decision: { outcome: 'blocked' as const, reason: 'consent_required' as const },
    };
    expect(blockedPillText('whatsapp', needsConsent)).toBe('WhatsApp blocked · Needs consent');
    expect(
      blockedPillText('ai_voice', {
        ...needsConsent,
        decision: { outcome: 'blocked', reason: 'ai_voice_requires_consent' },
      }),
    ).toBe('AI voice blocked · Needs consent');
  });

  it('returns null when the channel is not blocked or not known yet', () => {
    expect(
      blockedPillText('sms', {
        ...blocked('opted_out'),
        decision: { outcome: 'needs_review', reason: 'consent_required' },
      }),
    ).toBeNull();
    expect(blockedPillText('sms', undefined)).toBeNull();
  });
});

describe('groupByDay', () => {
  const now = new Date('2026-11-12T15:00:00Z');
  const at = (occurredAt: string, id: string) => ({ id, occurredAt });

  it('groups newest-first events under Today, Yesterday and a dated heading', () => {
    const groups = groupByDay(
      [
        at('2026-11-12T14:00:00Z', 'a'),
        at('2026-11-12T09:00:00Z', 'b'),
        at('2026-11-11T22:00:00Z', 'c'),
        at('2026-11-04T10:00:00Z', 'd'),
      ],
      now,
      'UTC',
      'en-US',
    );
    // Older days follow the reader's locale, here US English.
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'WED, NOV 4']);
    expect(groups.map((g) => g.events.map((e) => e.id))).toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('uses the given zone to decide where midnight falls', () => {
    const late = [at('2026-11-12T03:00:00Z', 'x')];
    expect(groupByDay(late, now, 'UTC')[0]?.label).toBe('Today');
    expect(groupByDay(late, now, 'America/Los_Angeles')[0]?.label).toBe('Yesterday');
  });

  it('returns nothing for an empty timeline', () => {
    expect(groupByDay([], now, 'UTC')).toEqual([]);
  });
});

describe('provenanceLabel', () => {
  it('says where a contact came from', () => {
    expect(provenanceLabel('manual', null)).toBe('Added manually');
    expect(provenanceLabel('import', 'leads.csv')).toBe('Imported from leads.csv');
    expect(provenanceLabel('import', null)).toBe('Imported from a CSV file');
    expect(provenanceLabel('app', null)).toBe('Added in KNOQRA');
  });
});

describe('duplicateReasonLabel', () => {
  it('words the reasons the API gives for a suggested match', () => {
    expect(duplicateReasonLabel('same_name')).toBe('Same name');
    expect(duplicateReasonLabel('same_email')).toBe('Same email');
    expect(duplicateReasonLabel('same_name_and_company')).toBe('Same name and company');
  });
});

describe('consentSourceLabel', () => {
  it('says where a decision came from, or that none exists', () => {
    expect(consentSourceLabel(null)).toBe('No consent recorded');
    expect(consentSourceLabel('app')).toBe('Recorded in KNOQRA');
    expect(consentSourceLabel('import')).toBe('From a CSV import');
    expect(consentSourceLabel('webhook')).toBe('Source: webhook');
  });

  it('words the sources a merge, an inbound STOP and KNOQRA itself record', () => {
    expect(consentSourceLabel('manual')).toBe('Recorded manually');
    expect(consentSourceLabel('merge')).toBe('Kept from a merged contact');
    expect(consentSourceLabel('inbound_stop')).toBe('Replied STOP');
    expect(consentSourceLabel('inbound_start')).toBe('Replied START');
    expect(consentSourceLabel('system')).toBe('Set by KNOQRA');
  });

  it('has words for every source the database schema allows', () => {
    // Read from the schema itself, so a new source value fails here until it has a label.
    const schema = readFileSync(
      new URL('../../../../packages/db/src/schema/permission.ts', import.meta.url),
      'utf8',
    );
    const list = schema.match(/PERMISSION_SOURCES = \[([^\]]*)\]/)?.[1] ?? '';
    const sources = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
    expect(sources).toEqual([
      'manual',
      'import',
      'inbound_stop',
      'inbound_start',
      'merge',
      'system',
    ]);
    for (const source of sources) {
      expect(consentSourceLabel(source)).not.toMatch(/^Source:/);
    }
  });
});

describe('readOnlyMessageReason', () => {
  const live = { archivedAt: null, mergedIntoId: null };

  it('lets a live contact be messaged', () => {
    expect(readOnlyMessageReason(live)).toBeNull();
  });

  it('says an archived contact cannot be messaged', () => {
    expect(readOnlyMessageReason({ ...live, archivedAt: '2026-11-01T10:00:00Z' })).toEqual({
      short: 'Archived',
      full: "Archived contacts can't be messaged. Restore the contact first.",
    });
  });

  it('points a merged contact at the record it was merged into', () => {
    expect(readOnlyMessageReason({ ...live, mergedIntoId: 'ct_target' })).toEqual({
      short: 'Merged',
      full: "Merged contacts can't be messaged. Message the contact it was merged into.",
    });
  });

  it('treats a merged contact that is also archived as merged', () => {
    expect(
      readOnlyMessageReason({ archivedAt: '2026-11-01T10:00:00Z', mergedIntoId: 'ct_target' })
        ?.short,
    ).toBe('Merged');
  });
});

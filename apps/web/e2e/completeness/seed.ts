import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { postFakeEvent } from '../fake-webhooks';
import type { SeedIds } from './routes';

interface SeedContact {
  key: string;
  displayName: string;
  phone: string;
  company?: string;
  email?: string;
  jobTitle?: string;
  timezone?: string;
  tags?: string[];
}

/** Clearly fictional people. Phones are unique per org (a fresh account gets a fresh org). */
const CONTACTS: readonly SeedContact[] = [
  {
    key: 'full',
    displayName: 'Marisol Quintero',
    phone: '+1 202 555 0101',
    company: 'Quintero Tile Works',
    email: 'marisol@example.test',
    jobTitle: 'Owner',
    timezone: 'America/Chicago',
    tags: ['customer', 'tile'],
  },
  {
    key: 'mergeTarget',
    displayName: 'Dev Okonkwo',
    phone: '+1 202 555 0102',
    company: 'Okonkwo Logistics',
    email: 'dev@example.test',
    timezone: 'America/New_York',
    tags: ['partner'],
  },
  {
    key: 'mergedSource',
    displayName: 'Dev Okonkwo',
    phone: '+1 202 555 0103',
    company: 'Okonkwo Logistics',
    jobTitle: 'Operations lead',
    tags: ['partner', 'logistics'],
  },
  {
    key: 'archived',
    displayName: 'Greta Lindqvist',
    phone: '+1 202 555 0104',
    company: 'Lindqvist Studio',
    timezone: 'Europe/Stockholm',
    tags: ['former'],
  },
  {
    key: 'empty',
    displayName: 'Tobias Wren',
    phone: '+1 202 555 0105',
  },
  {
    key: 'extra1',
    displayName: 'Priya Raman',
    phone: '+1 202 555 0106',
    company: 'Raman Textiles',
    timezone: 'Asia/Kolkata',
    tags: ['lead'],
  },
  {
    key: 'extra2',
    displayName: 'Anselm Fraser',
    phone: '+1 202 555 0107',
    company: 'Fraser Joinery',
    timezone: 'Europe/London',
    tags: ['lead', 'wood'],
  },
  {
    key: 'extra3',
    displayName: 'Noor Haddad',
    phone: '+1 202 555 0108',
    timezone: 'America/Los_Angeles',
  },
];

const IMPORTED_ROWS = [
  { displayName: 'Imogen Pratt', phone: '+1 202 555 0111', company: 'Pratt Bakery' },
  { displayName: 'Kofi Mensah', phone: '+1 202 555 0112', company: 'Mensah Print' },
  { displayName: 'Lucia Ferrante', phone: '+1 202 555 0113' },
];

/** Stable display names the visual baselines rely on. */
export const SEED_NAMES: readonly string[] = [
  ...new Set([...CONTACTS.map((c) => c.displayName), ...IMPORTED_ROWS.map((r) => r.displayName)]),
];

interface Envelope<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

async function call<T>(
  step: string,
  request: APIRequestContext,
  method: 'post' | 'put',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await request[method](path, { data: body });
  const text = await response.text();
  let parsed: Envelope<T> | undefined;
  try {
    parsed = JSON.parse(text) as Envelope<T>;
  } catch {
    parsed = undefined;
  }
  if (!response.ok() || parsed === undefined || parsed.error !== null) {
    throw new Error(`Seed step "${step}" failed with ${response.status()}: ${text.slice(0, 300)}`);
  }
  return parsed.data as T;
}

async function createContact(request: APIRequestContext, c: SeedContact): Promise<string> {
  const { key, ...fields } = c;
  const created = await call<{ id: string }>(`create ${key}`, request, 'post', '/api/v1/contacts', {
    displayName: fields.displayName,
    phone: fields.phone,
    company: fields.company,
    email: fields.email,
    jobTitle: fields.jobTitle,
    timezone: fields.timezone,
    tags: fields.tags,
  });
  return created.id;
}

/** `request` must carry the signed-in cookies (page.request after signUp). */
export async function seedWorkspace(request: APIRequestContext): Promise<SeedIds> {
  const ids = new Map<string, string>();
  for (const c of CONTACTS) ids.set(c.key, await createContact(request, c));
  const id = (key: string): string => {
    const value = ids.get(key);
    if (value === undefined) throw new Error(`Seed bug: no id for ${key}`);
    return value;
  };

  for (const channel of ['sms', 'whatsapp']) {
    await call(
      `consent ${channel}`,
      request,
      'put',
      `/api/v1/contacts/${id('full')}/permissions/${channel}`,
      {
        status: 'granted',
        evidence: 'Agreed by reply to the welcome message.',
      },
    );
  }
  await call('note on full', request, 'post', `/api/v1/contacts/${id('full')}/notes`, {
    body: 'Wants a quote for 40 m2 of tile. Call back after the site visit.',
  });
  await call('merge', request, 'post', `/api/v1/contacts/${id('mergeTarget')}/merge`, {
    sourceId: id('mergedSource'),
  });
  await call('archive', request, 'post', `/api/v1/contacts/${id('archived')}/archive`);
  const imported = await call<{
    results: { index: number; status: string; error: { code: string; message: string } | null }[];
  }>('import', request, 'post', '/api/v1/contacts/import', {
    fileName: 'contacts.csv',
    onDuplicate: 'skip',
    rows: IMPORTED_ROWS,
  });
  if (imported.results.length !== IMPORTED_ROWS.length) {
    throw new Error(
      `Seed step "import" returned ${imported.results.length} results for ${IMPORTED_ROWS.length} rows`,
    );
  }
  for (const row of imported.results) {
    if (row.error !== null || row.status !== 'created') {
      throw new Error(
        `Seed step "import" row ${row.index} was ${row.status}: ${row.error?.code ?? 'no error'} ${row.error?.message ?? ''}`.trim(),
      );
    }
  }

  await seedPhaseOne(request);

  return {
    full: id('full'),
    mergeTarget: id('mergeTarget'),
    mergedSource: id('mergedSource'),
    archived: id('archived'),
    empty: id('empty'),
  };
}

/**
 * Phase 1 screens get something to show, all on the fake provider and the sandbox senders (no
 * live keys, nothing leaves the machine): an inbound SMS thread from the full contact for Inbox,
 * and an inbound voicemail from the merge target for Calls. No number is bought: a bought number
 * is claimed globally, and the number-purchase spec owns that small pool.
 */
async function seedPhaseOne(request: APIRequestContext): Promise<void> {
  const senders = await call<{ items: { channel: string; address: string }[] }>(
    'sandbox senders',
    request,
    'put',
    '/api/v1/messaging/sandbox',
    { sms: 'approved', whatsapp: 'approved' },
  );
  const sms = senders.items.find((item) => item.channel === 'sms');
  if (!sms) throw new Error('Seed step "sandbox senders" returned no SMS sender');
  await postFakeEvent(request, {
    type: 'message.received',
    resourceId: `fake_in_${randomUUID().replaceAll('-', '')}`,
    payload: {
      channel: 'sms',
      from: '+12025550101',
      to: sms.address,
      body: 'Can you send the tile quote before Friday?',
    },
  });
  const voicemail = await request.post('/api/v1/dev/fake-voice/inbound', {
    data: { from: '+12025550102', scenario: 'voicemail' },
  });
  if (voicemail.status() !== 202) {
    throw new Error(
      `Seed step "voicemail" failed with ${voicemail.status()}: ${(await voicemail.text()).slice(0, 300)}`,
    );
  }
}

const THROWAWAY_FIRST = 114;
const THROWAWAY_LAST = 199;

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * A disposable contact for destructive controls. Phones come from +1 202 555 0114..0199, the
 * fictional range left free by the fixed seed (0101-0108) and the import rows (0111-0113). Only a
 * duplicate-phone conflict moves on to the next number; any other failure throws.
 */
export async function createThrowaway(request: APIRequestContext, label: string): Promise<string> {
  const suffixes = shuffled(
    Array.from({ length: THROWAWAY_LAST - THROWAWAY_FIRST + 1 }, (_, i) => THROWAWAY_FIRST + i),
  );
  for (const n of suffixes) {
    const response = await request.post('/api/v1/contacts', {
      data: {
        displayName: `Throwaway ${label}`,
        phone: `+1 202 555 ${String(n).padStart(4, '0')}`,
      },
    });
    const text = await response.text();
    let parsed: Envelope<{ id: string }> | undefined;
    try {
      parsed = JSON.parse(text) as Envelope<{ id: string }>;
    } catch {
      parsed = undefined;
    }
    if (response.status() === 409 && parsed?.error?.code === 'duplicate_contact') continue;
    if (!response.ok() || parsed?.data == null) {
      throw new Error(
        `Seed step "throwaway ${label}" failed with ${response.status()}: ${text.slice(0, 300)}`,
      );
    }
    return parsed.data.id;
  }
  throw new Error(
    `Seed step "throwaway ${label}" found no free phone in +1 202 555 0114..0199 (all taken)`,
  );
}

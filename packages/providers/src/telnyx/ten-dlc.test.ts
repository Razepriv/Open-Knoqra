import { describe, expect, it } from 'vitest';
import { TelnyxApiError } from './errors';
import {
  assignmentPhase,
  brandPhase,
  campaignPhase,
  TelnyxTenDlcClient,
  type TenDlcCampaignRequest,
} from './ten-dlc';

const API_KEY = 'KEY_FAKE_TENDLC_000000';
const BASE = 'https://api.telnyx.com/v2';

type Call = { url: string; method: string; body: unknown; auth: string | null };

/** Answers from a list of [method, url-prefix, response]; anything else throws (no network). */
function stub(routes: [string, string, () => Response][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const route = routes.find(([m, prefix]) => m === method && url.startsWith(prefix));
    if (!route) throw new Error(`unexpected network call: ${method} ${url}`);
    return route[2]();
  }) as typeof fetch;
  return { calls, client: new TelnyxTenDlcClient({ apiKey: API_KEY, fetch: fetchImpl }) };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TelnyxTenDlcClient', () => {
  it('creates a sole proprietor brand with only the fields given, unwrapped', async () => {
    const { calls, client } = stub([
      [
        'POST',
        `${BASE}/10dlc/brand`,
        json(200, { brandId: 'b-1', identityStatus: 'SELF_DECLARED', status: 'OK' }),
      ],
    ]);
    const brand = await client.createBrand({
      entityType: 'SOLE_PROPRIETOR',
      displayName: 'Pat Plumbing',
      firstName: 'Pat',
      lastName: 'Lee',
      mobilePhone: '+12025550123',
      country: 'US',
      email: 'pat@example.test',
      vertical: 'PROFESSIONAL',
      companyName: '',
    });
    expect(brand).toEqual({
      brandId: 'b-1',
      identityStatus: 'SELF_DECLARED',
      status: 'OK',
      failureReason: null,
    });
    expect(calls[0]?.auth).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.body).toEqual({
      entityType: 'SOLE_PROPRIETOR',
      displayName: 'Pat Plumbing',
      firstName: 'Pat',
      lastName: 'Lee',
      mobilePhone: '+12025550123',
      country: 'US',
      email: 'pat@example.test',
      vertical: 'PROFESSIONAL',
    });
  });

  it('sends and verifies the sole proprietor code', async () => {
    const { calls, client } = stub([
      ['POST', `${BASE}/10dlc/brand/b-1/smsOtp`, json(200, { brandId: 'b-1', referenceId: 'r' })],
      ['PUT', `${BASE}/10dlc/brand/b-1/smsOtp`, () => new Response(null, { status: 204 })],
    ]);
    await client.sendBrandOtp('b-1', 'Your code is @OTP_PIN@', 'Verified');
    await client.verifyBrandOtp('b-1', '123456');
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['POST', { pinSms: 'Your code is @OTP_PIN@', successSms: 'Verified' }],
      ['PUT', { otpPin: '123456' }],
    ]);
  });

  it('keeps a wrong code as a 400 with the code only', async () => {
    const { client } = stub([
      [
        'PUT',
        `${BASE}/10dlc/brand/b-1/smsOtp`,
        json(400, { errors: [{ code: '10015', detail: 'pin 123456 wrong' }] }),
      ],
    ]);
    const error = await client.verifyBrandOtp('b-1', '123456').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    expect((error as TelnyxApiError).status).toBe(400);
    expect((error as Error).message).not.toContain('123456');
  });

  it('creates a campaign and reads its status and failure reasons', async () => {
    const { calls, client } = stub([
      [
        'POST',
        `${BASE}/10dlc/campaignBuilder`,
        json(200, { campaignId: 'c-1', campaignStatus: 'TCR_PENDING' }),
      ],
      [
        'GET',
        `${BASE}/10dlc/campaign/c-1`,
        json(200, {
          campaignId: 'c-1',
          campaignStatus: 'TELNYX_FAILED',
          failureReasons: [{ description: 'Sample messages need opt-out language' }],
        }),
      ],
    ]);
    const request = {
      brandId: 'b-1',
      usecase: 'CUSTOMER_CARE',
      referenceId: 'sr_1',
    } as TenDlcCampaignRequest;
    expect(await client.createCampaign(request)).toEqual({
      campaignId: 'c-1',
      campaignStatus: 'TCR_PENDING',
      failureReason: null,
    });
    expect(calls[0]?.body).toMatchObject({ brandId: 'b-1', referenceId: 'sr_1' });
    expect(await client.getCampaign('c-1')).toEqual({
      campaignId: 'c-1',
      campaignStatus: 'TELNYX_FAILED',
      failureReason: 'Sample messages need opt-out language',
    });
  });

  it('assigns a number and reads a missing assignment as null', async () => {
    const { calls, client } = stub([
      [
        'POST',
        `${BASE}/10dlc/phone_number_campaigns`,
        json(200, {
          phoneNumber: '+12025550100',
          campaignId: 'c-1',
          assignmentStatus: 'PENDING_ASSIGNMENT',
        }),
      ],
      [
        'GET',
        `${BASE}/10dlc/phone_number_campaigns/%2B12025550100`,
        json(404, { errors: [{ code: '10005' }] }),
      ],
    ]);
    expect((await client.assignNumber('+12025550100', 'c-1')).assignmentStatus).toBe(
      'PENDING_ASSIGNMENT',
    );
    expect(calls[0]?.body).toEqual({ phoneNumber: '+12025550100', campaignId: 'c-1' });
    expect(await client.getAssignment('+12025550100')).toBeNull();
  });

  it('reuses a messaging profile by name, else creates one with the webhook', async () => {
    const reuse = stub([
      ['GET', `${BASE}/messaging_profiles?`, json(200, { data: [{ id: 'mp-1', name: 'KNOQRA' }] })],
    ]);
    expect(
      await reuse.client.ensureMessagingProfile(
        'KNOQRA',
        'https://api.example.test/webhooks/telnyx',
      ),
    ).toBe('mp-1');
    const create = stub([
      ['GET', `${BASE}/messaging_profiles?`, json(200, { data: [] })],
      ['POST', `${BASE}/messaging_profiles`, json(200, { data: { id: 'mp-2' } })],
    ]);
    expect(
      await create.client.ensureMessagingProfile(
        'KNOQRA',
        'https://api.example.test/webhooks/telnyx',
      ),
    ).toBe('mp-2');
    expect(create.calls[1]?.body).toEqual({
      name: 'KNOQRA',
      whitelisted_destinations: ['US'],
      webhook_url: 'https://api.example.test/webhooks/telnyx',
      webhook_api_version: '2',
    });
  });

  it('finds the number resource and puts it on the profile', async () => {
    const { calls, client } = stub([
      [
        'GET',
        `${BASE}/phone_numbers?filter%5Bphone_number%5D=12025550100`,
        json(200, {
          data: [{ id: '42', phone_number: '+12025550100', messaging_profile_id: null }],
        }),
      ],
      ['PATCH', `${BASE}/phone_numbers/42/messaging`, json(200, { data: { id: '42' } })],
    ]);
    expect(await client.findNumber('+12025550100')).toEqual({ id: '42', messagingProfileId: null });
    await client.setNumberProfile('42', 'mp-1');
    expect(calls[1]?.body).toEqual({ messaging_profile_id: 'mp-1' });
  });
});

describe('10DLC phases', () => {
  it('reads campaign, brand and assignment statuses', () => {
    expect(campaignPhase('MNO_PROVISIONED')).toBe('approved');
    expect(campaignPhase('MNO_PENDING')).toBe('pending');
    expect(campaignPhase('TELNYX_FAILED')).toBe('rejected');
    expect(campaignPhase(null)).toBe('pending');
    const brand = { brandId: 'b', status: 'OK', failureReason: null };
    expect(brandPhase({ ...brand, identityStatus: 'VERIFIED' })).toBe('verified');
    expect(brandPhase({ ...brand, identityStatus: 'UNVERIFIED' })).toBe('rejected');
    expect(brandPhase({ ...brand, identityStatus: 'PENDING' })).toBe('pending');
    expect(
      brandPhase({ ...brand, identityStatus: 'VERIFIED', status: 'REGISTRATION_FAILED' }),
    ).toBe('rejected');
    expect(assignmentPhase('ASSIGNED')).toBe('assigned');
    expect(assignmentPhase('FAILED_ASSIGNMENT')).toBe('failed');
    expect(assignmentPhase('PENDING_ASSIGNMENT')).toBe('pending');
  });
});

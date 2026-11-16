import { describe, expect, it } from 'vitest';
import { encodeForm } from './form';
import { NONCE_HEADER, SIGNATURE_HEADER, signPlivoV3, verifyPlivoV3 } from './signature';

/**
 * Official V3 test vectors from Plivo's SDK test suites (plivo-go `utils_test.go`; the same values
 * are in plivo-ruby `spec/signature_spec.rb` and plivo-dotnet `TestSignatureV3.cs`).
 */
const VECTOR = {
  authToken: 'Y2Q2ZDgxZmY5YWRiOTI5YmQ1Njg0MTAxZWIyOTc4',
  nonce: '31627761595286130198',
  params: {
    Direction: 'outbound',
    From: '19792014278',
    ALegUUID: '3e82ae9d-2c78-4d85-b1a4-6eae7dbafb36',
    CallStatus: 'in-progress',
    BillRate: '0.002',
    ParentAuthID: 'MANWVLYTK4ZWU1YTY4QA',
    To: 'sip:PlivoSignature382029104058171078704104@phone-qa.voice.plivodev.com',
    ALegRequestUUID: '3e82ae9d-2c78-4d85-b1a4-6eae7dbafb36',
    CallUUID: '3e82ae9d-2c78-4d85-b1a4-6eae7dbafb36',
    RequestUUID: '3e82ae9d-2c78-4d85-b1a4-6eae7dbafb36',
    'SIP-H-To': '<sip:PlivoSignature382029104058171078704104@52.9.11.55;transport=udp>;tag=1',
    SessionStart: '2020-04-08 11:34:33.238707',
    Event: 'StartApp',
  },
};
const WITH_QUERY = 'https://plivobin.non-prod.plivops.com/api/v1/validate_signature03.xml/?a=b&c=d';
const NO_QUERY = 'https://plivobin.non-prod.plivops.com/api/v1/validate_signature03.xml';

const body = encodeForm(VECTOR.params);
const headers = (signature: string, nonce = VECTOR.nonce) =>
  new Headers({ [SIGNATURE_HEADER]: signature, [NONCE_HEADER]: nonce });

describe('Plivo V3 signature', () => {
  it('matches the official POST vector for a URL with a query string', async () => {
    expect(
      await signPlivoV3({
        url: WITH_QUERY,
        nonce: VECTOR.nonce,
        authToken: VECTOR.authToken,
        body,
      }),
    ).toBe('k7Pusd4OxCIjR5IfA9iedDNu/h/gbdYqdzG/MiYtd1c=');
  });

  it('matches the official POST vector for a URL without one', async () => {
    expect(
      await signPlivoV3({ url: NO_QUERY, nonce: VECTOR.nonce, authToken: VECTOR.authToken, body }),
    ).toBe('iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=');
  });

  it('does not depend on the order the fields arrive in', async () => {
    const reversed = encodeForm(Object.fromEntries(Object.entries(VECTOR.params).reverse()));
    expect(
      await signPlivoV3({
        url: NO_QUERY,
        nonce: VECTOR.nonce,
        authToken: VECTOR.authToken,
        body: reversed,
      }),
    ).toBe('iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=');
  });

  const verify = (over: Partial<Parameters<typeof verifyPlivoV3>[0]>) =>
    verifyPlivoV3({
      url: NO_QUERY,
      headers: headers('iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0='),
      authToken: VECTOR.authToken,
      body,
      ...over,
    });

  it('accepts the vector, also as one of several signatures', async () => {
    expect(await verify({})).toBe(true);
    expect(
      await verify({
        headers: headers('bm90LXRoaXMtb25l, iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0='),
      }),
    ).toBe(true);
  });

  it('rejects another URL, nonce, token or body', async () => {
    expect(await verify({ url: `${NO_QUERY}/` })).toBe(false);
    expect(await verify({ url: 'https://evil.example/api/v1/validate_signature03.xml' })).toBe(
      false,
    );
    expect(
      await verify({ headers: headers('iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=', '1') }),
    ).toBe(false);
    expect(await verify({ authToken: `${VECTOR.authToken}x` })).toBe(false);
    expect(await verify({ body: encodeForm({ ...VECTOR.params, Event: 'Hangup' }) })).toBe(false);
  });

  it('rejects missing headers, an empty nonce, an empty token and too many signatures', async () => {
    expect(await verify({ headers: new Headers() })).toBe(false);
    expect(
      await verify({
        headers: new Headers({
          [SIGNATURE_HEADER]: 'iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=',
        }),
      }),
    ).toBe(false);
    expect(
      await verify({ headers: headers('iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=', '') }),
    ).toBe(false);
    expect(await verify({ authToken: '' })).toBe(false);
    const many = Array.from({ length: 9 }, () => 'iAjE5QqI37mbkYe4w3jTMudqEzbDufdqi7sYwTu64e0=');
    expect(await verify({ headers: headers(many.join(',')) })).toBe(false);
  });

  it('refuses a URL it cannot parse', async () => {
    expect(await signPlivoV3({ url: 'not a url', nonce: '1', authToken: 't', body })).toBeNull();
  });
});

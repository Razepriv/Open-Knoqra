import { describe, expect, it } from 'vitest';
import { escapeXml, plivoXml } from './xml';

describe('plivoXml', () => {
  it('dials a number with the caller id and the dial callback', () => {
    expect(
      plivoXml.dial({
        callerId: '+12025550110',
        target: { kind: 'number', e164: '+12025550123' },
        callbackUrl: 'https://api.example.test/webhooks/plivo/org_1',
      }),
    ).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+12025550110" ' +
        'callbackUrl="https://api.example.test/webhooks/plivo/org_1" callbackMethod="POST">' +
        '<Number>+12025550123</Number></Dial></Response>',
    );
  });

  it('dials a browser endpoint', () => {
    expect(
      plivoXml.dial({
        callerId: '+12025550123',
        target: { kind: 'user', sipUri: 'sip:knoqra1@phone.plivo.com' },
        callbackUrl: 'https://x.test/a?b=1&c=2',
      }),
    ).toContain('callbackUrl="https://x.test/a?b=1&amp;c=2"');
  });

  it('escapes every special character', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });

  it('hangs up', () => {
    expect(plivoXml.hangup()).toContain('<Hangup reason="rejected"/>');
  });
});

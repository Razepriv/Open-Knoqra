import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MESSAGING_CHANNELS, type MessagingChannel } from '@knoqra/core';
import {
  buildFakeCallEvent,
  FakeProvider,
  fakeMessageEvent,
  type ProviderEventType,
  toFakeWebhookBody,
} from '@knoqra/providers';

/**
 * Posts signed fake-provider webhooks to a running API.
 *
 *   simulate outbound-answered
 *   simulate inbound --org <orgId> [--from +12025550142] [--voicemail]
 *   simulate inbound <sms|whatsapp> <to-address> <from-e164> <body...>
 *   simulate receipt <sms|whatsapp> <from-address> <providerMessageId> <sent|delivered|read|failed>
 *
 * The URL is WEBHOOK_URL, else http://localhost:$KNOQRA_API_PORT/webhooks/fake (port 8787 when unset).
 */
const ENDPOINT =
  process.env.WEBHOOK_URL ??
  `http://localhost:${process.env.KNOQRA_API_PORT ?? '8787'}/webhooks/fake`;

/** The number fake inbound calls ring (the dev fake-voice endpoint uses the same one). */
const FAKE_INBOUND_TO = '+12025550100';
const DEFAULT_FROM = '+12025550142';
const VOICEMAIL_TRANSCRIPT = "Hi, it's about Thursday's review. Call me back.";
const VOICEMAIL_SECONDS = 22;
const USAGE = [
  'usage:',
  '  simulate outbound-answered',
  '  simulate inbound --org <orgId> [--from <e164>] [--voicemail]',
  '  simulate inbound <sms|whatsapp> <to-address> <from-e164> <body...>',
  '  simulate receipt <sms|whatsapp> <from-address> <providerMessageId> <sent|delivered|read|failed>',
].join('\n');
const RECEIPTS = ['sent', 'delivered', 'read', 'failed'] as const;

function readDevVar(name: string): string | undefined {
  try {
    const line = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

const out = (line: string) => process.stdout.write(`${line}\n`);

/** Signs and posts one body; prints `<status> <type> <event id>` and returns whether it was 2xx. */
async function post(fake: FakeProvider, body: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(body);
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fake-signature': await fake.signWebhook(bytes),
    },
    body: bytes,
  });
  const { id, type } = JSON.parse(body) as { id: string; type: string };
  out(`${response.status} ${type} ${id}`);
  return response.ok;
}

function outboundAnswered(fake: FakeProvider): string[] {
  const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
  return fake.scenario('outbound-answered', callId).map(toFakeWebhookBody);
}

function inboundCall(args: string[]): string[] | string {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: 'string' },
      from: { type: 'string', default: DEFAULT_FROM },
      voicemail: { type: 'boolean', default: false },
    },
  });
  if (!values.org) return USAGE;
  const providerCallId = `fake_in_${crypto.randomUUID().replaceAll('-', '')}`;
  const payload = {
    direction: 'inbound',
    from: values.from,
    to: FAKE_INBOUND_TO,
    org_id: values.org,
  };
  const bodies = [buildFakeCallEvent({ type: 'call.initiated', providerCallId, payload }).body];
  if (values.voicemail) {
    bodies.push(
      buildFakeCallEvent({
        type: 'call.voicemail',
        providerCallId,
        occurredAt: new Date(Date.now() + 1000).toISOString(),
        payload: {
          ...payload,
          duration_seconds: VOICEMAIL_SECONDS,
          transcript: VOICEMAIL_TRANSCRIPT,
        },
      }).body,
    );
  }
  out(`inbound call ${providerCallId}`);
  return bodies;
}

const isMessagingChannel = (value: string | undefined): value is MessagingChannel =>
  value !== undefined && (MESSAGING_CHANNELS as readonly string[]).includes(value);

function inboundMessage(channel: MessagingChannel, args: string[]): string[] | string {
  const [to, from, ...rest] = args;
  const body = rest.join(' ');
  if (!to || !from || body.length === 0) return `inbound: missing arguments\n${USAGE}`;
  const id = `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`;
  return [
    toFakeWebhookBody(
      fakeMessageEvent({
        type: 'message.received',
        providerMessageId: id,
        payload: { channel, from, to, body },
      }),
    ),
  ];
}

function receipt(args: string[]): string[] | string {
  const [channel, from, providerMessageId, status] = args;
  if (!isMessagingChannel(channel)) return `receipt: channel must be sms or whatsapp\n${USAGE}`;
  if (!from || !providerMessageId) return `receipt: missing arguments\n${USAGE}`;
  if (!RECEIPTS.includes(status as (typeof RECEIPTS)[number])) {
    return `receipt: status must be sent, delivered, read or failed\n${USAGE}`;
  }
  return [
    toFakeWebhookBody(
      fakeMessageEvent({
        type: `message.${status}` as ProviderEventType,
        providerMessageId,
        payload: {
          channel,
          from,
          to: 'contact',
          ...(status === 'failed'
            ? { error: { code: 'simulated', message: 'Simulated delivery failure' } }
            : {}),
        },
      }),
    ),
  ];
}

/** `inbound sms|whatsapp ...` is a message; `inbound --org ...` is a call. */
function plan(name: string, rest: string[], fake: FakeProvider): string[] | string {
  if (name === 'outbound-answered') return outboundAnswered(fake);
  if (name === 'inbound') {
    const [first, ...args] = rest;
    return isMessagingChannel(first) ? inboundMessage(first, args) : inboundCall(rest);
  }
  if (name === 'receipt') return receipt(rest);
  return `unknown scenario: ${name}\n${USAGE}`;
}

async function main(): Promise<number> {
  const [name = 'outbound-answered', ...rest] = process.argv.slice(2);
  const secret = process.env.FAKE_WEBHOOK_SECRET ?? readDevVar('FAKE_WEBHOOK_SECRET');
  if (!secret) {
    out('FAKE_WEBHOOK_SECRET is not set (env or apps/api/.dev.vars)');
    return 1;
  }
  const fake = new FakeProvider({ webhookSecret: secret });
  const bodies = plan(name, rest, fake);
  if (typeof bodies === 'string') {
    out(bodies);
    return 1;
  }
  let failures = 0;
  // Sequential on purpose: the queue then sees the ring before the voicemail.
  for (const body of bodies) {
    if (!(await post(fake, body))) failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    out(`simulate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);

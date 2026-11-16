export const SETUP_CHECK_IDS = ['credential', 'number', 'webhook', 'ten_dlc', 'whatsapp'] as const;
export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

export const SETUP_STEPS = ['connect', 'number', 'audio', 'test_call'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const TEN_DLC_STATES = ['not_required', 'none', 'pending', 'registered', 'failed'] as const;
export type TenDlcState = (typeof TEN_DLC_STATES)[number];

export const WHATSAPP_STATES = ['none', 'pending', 'approved', 'rejected'] as const;
export type WhatsAppState = (typeof WHATSAPP_STATES)[number];

export type CheckStatus = 'pass' | 'fail' | 'pending';

export type SetupFix =
  | { kind: 'wizard'; step: SetupStep }
  | { kind: 'external'; href: string; label: string };

export interface SetupFacts {
  provider: 'telnyx' | 'plivo' | 'fake' | 'none';
  credentialStored: boolean;
  lastPoll: 'ok' | 'auth_failed' | 'unavailable' | null;
  numbersSynced: number;
  assignedForCalls: boolean;
  webhookKeyConfigured: boolean;
  lastWebhookAt: Date | null;
  tenDlc: TenDlcState;
  whatsapp: WhatsAppState;
}

export interface SetupCheck {
  id: SetupCheckId;
  status: CheckStatus;
  title: string;
  detail: string;
  fix: SetupFix | null;
}

const DEPLOY_DOC_HREF = 'https://github.com/Razepriv/Open-Knoqra/blob/main/docs/self-host.md';
const TEN_DLC_HREF = 'https://portal.telnyx.com/#/app/messaging/compliance';
const WHATSAPP_HREF = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';

const isReal = (provider: SetupFacts['provider']): provider is 'telnyx' | 'plivo' =>
  provider === 'telnyx' || provider === 'plivo';

function credentialCheck(f: SetupFacts): SetupCheck {
  const fix: SetupFix = { kind: 'wizard', step: 'connect' };
  const name = f.provider === 'plivo' ? 'Plivo' : 'Telnyx';
  const title = `${name} credential`;
  if (!f.credentialStored) {
    return { id: 'credential', status: 'fail', title, detail: `No ${name} key saved yet.`, fix };
  }
  if (f.lastPoll === 'auth_failed') {
    return { id: 'credential', status: 'fail', title, detail: `${name} rejected the key`, fix };
  }
  if (isReal(f.provider) && (f.lastPoll === null || f.lastPoll === 'unavailable')) {
    return {
      id: 'credential',
      status: 'pending',
      title,
      detail: `Saved. Waiting for ${name} to confirm it.`,
      fix,
    };
  }
  const detail =
    f.provider === 'fake'
      ? 'Saved. Calls use the fake provider in development.'
      : `Saved and accepted by ${name}.`;
  return { id: 'credential', status: 'pass', title, detail, fix };
}

function numberCheck(f: SetupFacts): SetupCheck {
  const fix: SetupFix = { kind: 'wizard', step: 'number' };
  const title = 'Number assigned';
  if (f.numbersSynced === 0) {
    return { id: 'number', status: 'fail', title, detail: 'No numbers found on the account.', fix };
  }
  if (!f.assignedForCalls) {
    return {
      id: 'number',
      status: 'pending',
      title,
      detail: 'Pick a number to use for calls.',
      fix,
    };
  }
  return { id: 'number', status: 'pass', title, detail: 'A number is assigned for calls.', fix };
}

function webhookCheck(f: SetupFacts): SetupCheck {
  const title = 'Webhook reachable';
  if (f.provider === 'telnyx' && !f.webhookKeyConfigured) {
    return {
      id: 'webhook',
      status: 'fail',
      title,
      detail: 'The Telnyx webhook public key is not configured.',
      fix: { kind: 'external', href: DEPLOY_DOC_HREF, label: 'Set TELNYX_PUBLIC_KEY' },
    };
  }
  const fix: SetupFix = { kind: 'wizard', step: 'test_call' };
  if (f.lastWebhookAt === null) {
    return {
      id: 'webhook',
      status: 'pending',
      title,
      detail: 'No webhook received yet. Place a test call.',
      fix,
    };
  }
  return { id: 'webhook', status: 'pass', title, detail: 'Webhooks are arriving.', fix };
}

function tenDlcCheck(f: SetupFacts): SetupCheck {
  const fix: SetupFix = { kind: 'external', href: TEN_DLC_HREF, label: 'Register in Telnyx' };
  const title = '10DLC registration';
  if (f.tenDlc === 'registered' || f.tenDlc === 'not_required') {
    const detail =
      f.tenDlc === 'registered' ? 'Registered for US SMS.' : 'Not required for this number.';
    return { id: 'ten_dlc', status: 'pass', title, detail, fix };
  }
  if (f.tenDlc === 'pending') {
    return {
      id: 'ten_dlc',
      status: 'pending',
      title,
      detail: 'Registration is under review.',
      fix,
    };
  }
  return {
    id: 'ten_dlc',
    status: 'fail',
    title,
    detail: 'Needs a live Telnyx account. US SMS sending waits for 10DLC.',
    fix,
  };
}

function whatsappCheck(f: SetupFacts): SetupCheck {
  const fix: SetupFix = { kind: 'external', href: WHATSAPP_HREF, label: 'Start Meta approval' };
  const title = 'WhatsApp approval';
  if (f.whatsapp === 'approved') {
    return { id: 'whatsapp', status: 'pass', title, detail: 'Approved by Meta.', fix };
  }
  if (f.whatsapp === 'pending') {
    return {
      id: 'whatsapp',
      status: 'pending',
      title,
      detail: 'Meta is reviewing your account.',
      fix,
    };
  }
  return {
    id: 'whatsapp',
    status: 'fail',
    title,
    detail: 'Needs Meta approval of your WhatsApp Business account.',
    fix,
  };
}

export function evaluateSetupChecks(facts: SetupFacts): SetupCheck[] {
  return [
    credentialCheck(facts),
    numberCheck(facts),
    webhookCheck(facts),
    tenDlcCheck(facts),
    whatsappCheck(facts),
  ];
}

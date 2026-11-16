// Loads one organization's Phase 1 rows inside the organization's seed transaction (app.org_id is
// already set), parents before children so every composite foreign key holds per statement.
import type pg from 'pg';
import { out } from '../out';
import type { ContactRow } from './generate';
import { batches } from './generate';
import { type Column, insertBatch, loadStream } from './insert';
import { type OrgContext, type Phase1Plan, STREAMS } from './phase1';
import {
  generateConnections,
  generateConversations,
  generateMessages,
  generateTemplates,
  templatesByChannel,
} from './phase1-messaging';
import {
  generateLedger,
  generateNumbers,
  generateOrders,
  generateReconciliations,
  generateUsageEvents,
  generateWallet,
} from './phase1-money';
import { generateCalls } from './phase1-voice';
import { generateNotifications, generateTasks } from './phase1-work';
import { streamRand } from './random';

const cols = (spec: string): Column[] =>
  spec
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [name, type] = pair.split(':');
      return { name: name as string, type: type ?? 'text' };
    });

const TS = 'timestamptz';
const COLUMNS = {
  wallet: cols(`id organization_id created_at:${TS} updated_at:${TS}`),
  phone_number: cols(
    `id organization_id provider provider_number_id e164 status voice:boolean sms:boolean mms:boolean
     whatsapp:boolean ten_dlc_status whatsapp_status assigned_use last_synced_at:${TS}
     created_at:${TS} updated_at:${TS}`,
  ),
  channel_connection: cols(
    `id organization_id channel provider address registration_status created_at:${TS} updated_at:${TS}`,
  ),
  message_template: cols(
    `id organization_id name channel body approval_status archived_at:${TS} created_by
     created_at:${TS} whatsapp_template_name whatsapp_language`,
  ),
  number_quote: cols(
    `id organization_id provider e164 upfront_micros:bigint monthly_micros:bigint currency
     expires_at:${TS} created_by created_at:${TS}`,
  ),
  ledger_entry: cols(
    `id organization_id wallet_id kind balance_delta_micros:bigint held_delta_micros:bigint
     reservation_id ref_type ref_id idempotency_key note actor_user_id created_at:${TS}`,
  ),
  number_order: cols(
    `id organization_id quote_id provider e164 idempotency_key status provider_order_id
     upfront_micros:bigint monthly_micros:bigint reservation_id failure_code created_by
     created_at:${TS} updated_at:${TS}`,
  ),
  call: cols(
    `id organization_id user_id contact_id direction state from_e164 to_e164 provider
     provider_call_id client_state cost_micros:bigint outcome answered_at:${TS} ended_at:${TS}
     hangup_cause billable_seconds:integer created_at:${TS} updated_at:${TS}`,
  ),
  voicemail: cols(
    `id organization_id call_id contact_id from_e164 duration_seconds:integer transcript
     recording_key listened_at:${TS} created_at:${TS}`,
  ),
  conversation: cols(
    `id organization_id contact_id channel last_activity_at:${TS} last_inbound_at:${TS}
     last_message_preview last_message_direction last_message_status unread_count:integer
     created_at:${TS} updated_at:${TS}`,
  ),
  message: cols(
    `id organization_id conversation_id contact_id channel direction body template_id status
     error_code error_message provider provider_message_id client_message_id author_user_id
     occurred_at:${TS} status_updated_at:${TS} created_at:${TS}`,
  ),
  message_status_event: cols(
    `id organization_id message_id status applied:boolean occurred_at:${TS} error_code created_at:${TS}`,
  ),
  task: cols(
    `id organization_id owner_user_id contact_id title notes due_at:${TS} remind_at:${TS} status
     completed_at:${TS} created_at:${TS} updated_at:${TS}`,
  ),
  notification: cols(
    `id organization_id user_id kind title body ref_type ref_id dedupe_key read_at:${TS} created_at:${TS}`,
  ),
  usage_event: cols(
    `id organization_id user_id service quantity:integer unit cost_micros:bigint provider
     idempotency_key occurred_at:${TS} created_at:${TS}`,
  ),
  reconciliation_report: cols(
    `id organization_id period_date:date service trigger status captured_micros:bigint
     provider_micros:bigint ledger_micros:bigint drift_micros:bigint adjust_entry_id actor_user_id
     created_at:${TS}`,
  ),
} as const;

export type Phase1Table = keyof typeof COLUMNS;

/** Tables the Phase 1 seed writes, for ANALYZE and the summary line. */
export const PHASE1_TABLES = Object.keys(COLUMNS) as Phase1Table[];

async function insertAll(
  client: pg.Client,
  table: Phase1Table,
  rows: readonly object[],
): Promise<number> {
  for (const batch of batches(rows)) await insertBatch(client, table, COLUMNS[table], batch);
  if (rows.length > 0) out(`  ${table} ${rows.length}`);
  return rows.length;
}

export type Phase1LoadCounts = Partial<Record<Phase1Table, number>>;

async function loadMoney(client: pg.Client, ctx: OrgContext, plan: Phase1Plan) {
  const { seed, counts } = plan;
  const wallet = generateWallet(ctx);
  const numbers = generateNumbers(streamRand(seed, STREAMS.numbers), ctx, counts.numbers);
  const orders = generateOrders(
    streamRand(seed, STREAMS.orders),
    ctx,
    wallet.id,
    counts.numberOrders,
    numbers,
  );
  const recon = generateReconciliations(
    streamRand(seed, STREAMS.reconciliations),
    ctx,
    wallet.id,
    counts.reconciliations,
  );
  const loaded: Phase1LoadCounts = {
    wallet: await insertAll(client, 'wallet', [wallet]),
    phone_number: await insertAll(client, 'phone_number', numbers),
    number_quote: await insertAll(client, 'number_quote', orders.quotes),
  };
  loaded.ledger_entry = await loadStream(
    client,
    'ledger_entry',
    'ledger_entry',
    COLUMNS.ledger_entry,
    generateLedger(streamRand(seed, STREAMS.ledger), ctx, wallet.id, counts.ledger, [
      ...orders.ledger,
      ...recon.ledger,
    ]),
    counts.ledger,
  );
  loaded.number_order = await insertAll(client, 'number_order', orders.orders);
  loaded.reconciliation_report = await insertAll(client, 'reconciliation_report', recon.reports);
  loaded.usage_event = await insertAll(
    client,
    'usage_event',
    generateUsageEvents(streamRand(seed, STREAMS.usage), ctx, counts.usageEvents),
  );
  return { loaded, numbers };
}

async function loadCalls(
  client: pg.Client,
  ctx: OrgContext,
  plan: Phase1Plan,
  orgNumbers: string[],
): Promise<Phase1LoadCounts> {
  let calls = 0;
  let voicemails = 0;
  const stream = generateCalls(
    streamRand(plan.seed, STREAMS.calls),
    ctx,
    plan.counts.calls,
    Math.round(plan.counts.calls * plan.counts.voicemailRatio),
    plan.active,
    orgNumbers,
  );
  for (const batch of stream) {
    await insertBatch(client, 'call', COLUMNS.call, batch.calls);
    await insertBatch(client, 'voicemail', COLUMNS.voicemail, batch.voicemails);
    calls += batch.calls.length;
    voicemails += batch.voicemails.length;
  }
  out(`  call ${calls}, voicemail ${voicemails}`);
  return { call: calls, voicemail: voicemails };
}

async function loadMessaging(
  client: pg.Client,
  ctx: OrgContext,
  plan: Phase1Plan,
  address: string,
): Promise<Phase1LoadCounts> {
  const templates = generateTemplates(
    streamRand(plan.seed, STREAMS.templates),
    ctx,
    plan.counts.templates,
  );
  const byChannel = templatesByChannel(templates);
  const loaded: Phase1LoadCounts = {
    channel_connection: await insertAll(
      client,
      'channel_connection',
      generateConnections(ctx, address),
    ),
    message_template: await insertAll(client, 'message_template', templates),
  };
  loaded.conversation = await loadStream(
    client,
    'conversation',
    'conversation',
    COLUMNS.conversation,
    generateConversations(ctx, plan.conversations, byChannel),
    plan.conversations.length,
  );
  let messages = 0;
  let events = 0;
  let nextReport = 0;
  for (const batch of generateMessages(ctx, plan.conversations, byChannel)) {
    await insertBatch(client, 'message', COLUMNS.message, batch.messages);
    await insertBatch(client, 'message_status_event', COLUMNS.message_status_event, batch.events);
    messages += batch.messages.length;
    events += batch.events.length;
    if (messages >= nextReport) {
      out(`  message ${messages}/${plan.counts.messages}`);
      nextReport = messages + 100_000;
    }
  }
  if (messages !== plan.counts.messages) {
    throw new Error(`message: loaded ${messages}, expected ${plan.counts.messages}`);
  }
  return { ...loaded, message: messages, message_status_event: events };
}

async function loadWork(
  client: pg.Client,
  ctx: OrgContext,
  plan: Phase1Plan,
): Promise<Phase1LoadCounts> {
  const heavy = plan.active.find((c) => c.id === plan.heavyContactId) as ContactRow;
  const tasks = generateTasks(
    streamRand(plan.seed, STREAMS.tasks),
    ctx,
    plan.counts.tasks,
    plan.counts.heavyTasks,
    heavy,
    plan.active,
  );
  const notifications = generateNotifications(
    streamRand(plan.seed, STREAMS.notifications),
    ctx,
    plan.counts.notifications,
    plan.counts.unreadRatio,
    tasks,
  );
  return {
    task: await insertAll(client, 'task', tasks),
    notification: await insertAll(client, 'notification', notifications),
  };
}

/** Loads every Phase 1 table for one organization; the caller owns the transaction. */
export async function loadPhase1(
  client: pg.Client,
  ctx: OrgContext,
  plan: Phase1Plan,
): Promise<Phase1LoadCounts> {
  const money = await loadMoney(client, ctx, plan);
  const orgNumbers = money.numbers.map((n) => n.e164);
  return {
    ...money.loaded,
    ...(await loadCalls(client, ctx, plan, orgNumbers)),
    ...(await loadMessaging(client, ctx, plan, orgNumbers[0] as string)),
    ...(await loadWork(client, ctx, plan)),
  };
}

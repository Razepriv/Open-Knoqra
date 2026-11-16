// Explain cases for the Phase 1 hot paths: one per GET row of the M6c explain inventory, plus the
// deep-cursor variants it names. Budgets: detail 20 ms, list 50 ms, search 150 ms, usage summary
// and ledgers 100 ms.
import type { ExplainCase } from './registry';

const DETAIL = 20;
const LIST = 50;
const SEARCH = 150;
const LEDGER = 100;

/** Ruling R2: the inbox search is a substring match on contact, a bounded scan under RLS. */
const R2_CONVERSATION_SEARCH = {
  allowSeqScan: [{ table: 'contact', reason: 'R2: substring search on contact under RLS' }],
};

/**
 * Ruling T10-b: the usage ledger computes running balances with a window over the organization's
 * whole ledger, so every page costs O(ledger). The fix is a stored running balance, proposed in
 * docs/perf/2026-11-14-explain.md and parked until after Phase 1. The time is still reported, and
 * the case fails above a 3 s ceiling (measured 1.1-2.0 s), so a regression is still caught.
 */
const T10B_USAGE_LEDGER = {
  allowOverBudget: {
    reason:
      'T10-b: whole-org running-balance window; fix = stored running balance (proposed in docs/perf/2026-11-14-explain.md), parked post-Phase 1',
    ceilingMs: 3000,
  },
};

const get = (
  name: string,
  milestone: string,
  path: string,
  budgetMs: number,
  extra: Partial<ExplainCase> = {},
): ExplainCase => ({ name, milestone, method: 'GET', path, budgetMs, ...extra });

export const PHASE1_CASES: readonly ExplainCase[] = [
  // M2 calls, voicemails and the wallet ledger.
  get('calls.list.first', 'M2', '/api/v1/calls?limit=50', LIST),
  get('calls.list.deep', 'M2', '/api/v1/calls?limit=50&cursor={cursors.callsDeep}', LIST),
  get('calls.list.inbound', 'M2', '/api/v1/calls?direction=inbound&limit=50', LIST),
  get('calls.active', 'M2', '/api/v1/calls/active', DETAIL),
  get('voicemails.list', 'M2', '/api/v1/voicemails', LIST),
  get('wallet.ledger.first', 'M2', '/api/v1/wallet/ledger?limit=50', LEDGER),
  get(
    'wallet.ledger.deep',
    'M2',
    '/api/v1/wallet/ledger?limit=50&cursor={cursors.ledgerDeep}',
    LEDGER,
  ),
  // M3 inbox, thread and message detail.
  get('conversations.list.first', 'M3', '/api/v1/conversations?limit=50', LIST),
  get(
    'conversations.list.deep',
    'M3',
    '/api/v1/conversations?limit=50&cursor={cursors.conversationsDeep}',
    LIST,
  ),
  get('conversations.list.unread', 'M3', '/api/v1/conversations?filter=unread&limit=50', LIST),
  get('conversations.list.sms', 'M3', '/api/v1/conversations?filter=sms&limit=50', LIST),
  get('conversations.list.whatsapp', 'M3', '/api/v1/conversations?filter=whatsapp&limit=50', LIST),
  get(
    'conversations.search.name',
    'M3',
    '/api/v1/conversations?q={search.conversationName}&limit=50',
    SEARCH,
    R2_CONVERSATION_SEARCH,
  ),
  get(
    'conversations.search.digits',
    'M3',
    '/api/v1/conversations?q={search.conversationDigits}&limit=50',
    SEARCH,
    R2_CONVERSATION_SEARCH,
  ),
  get(
    'conversations.thread.first',
    'M3',
    '/api/v1/conversations/{ids.heavyConversation}/items?limit=50',
    LIST,
  ),
  get(
    'conversations.thread.deep',
    'M3',
    '/api/v1/conversations/{ids.heavyConversation}/items?limit=50&cursor={cursors.threadDeep}',
    LIST,
  ),
  get('messages.detail', 'M3', '/api/v1/messages/{ids.message}', DETAIL),
  // M3b templates.
  get('templates.list', 'M3b', '/api/v1/messaging/templates', LIST),
  get('templates.list.sms', 'M3b', '/api/v1/messaging/templates?channel=sms', LIST),
  // M4 numbers and usage.
  get('numbers.list', 'M4', '/api/v1/numbers', LIST),
  get('usage.summary', 'M4', '/api/v1/usage/summary?from={usage.from}&to={usage.to}', LEDGER),
  get('usage.ledger.first', 'M4', '/api/v1/usage/ledger?limit=50', LEDGER, T10B_USAGE_LEDGER),
  get(
    'usage.ledger.deep',
    'M4',
    '/api/v1/usage/ledger?limit=50&cursor={cursors.ledgerDeep}',
    LEDGER,
    T10B_USAGE_LEDGER,
  ),
  get(
    'usage.ledger.filtered',
    'M4',
    '/api/v1/usage/ledger?limit=50&from={usage.from}&to={usage.to}&channel=voice&kind=capture',
    LEDGER,
    T10B_USAGE_LEDGER,
  ),
  get('usage.reconciliations.first', 'M4', '/api/v1/usage/reconciliations?limit=50', LIST),
  get(
    'usage.reconciliations.deep',
    'M4',
    '/api/v1/usage/reconciliations?limit=50&cursor={cursors.reconciliationsDeep}',
    LIST,
  ),
  // M4b number orders.
  get('numbers.orders', 'M4b', '/api/v1/numbers/orders', LIST),
  // M5 tasks and notifications.
  get('tasks.open.first', 'M5', '/api/v1/tasks?status=open&limit=50', LIST),
  get(
    'tasks.open.deep',
    'M5',
    '/api/v1/tasks?status=open&limit=50&cursor={cursors.tasksOpenDeep}',
    LIST,
  ),
  get('tasks.done.first', 'M5', '/api/v1/tasks?status=done&limit=50', LIST),
  get(
    'tasks.done.deep',
    'M5',
    '/api/v1/tasks?status=done&limit=50&cursor={cursors.tasksDoneDeep}',
    LIST,
  ),
  get('tasks.byContact', 'M5', '/api/v1/tasks?status=open&contactId={ids.heavy}&limit=50', LIST),
  get('notifications.list', 'M5', '/api/v1/notifications?limit=20', LIST),
];

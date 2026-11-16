import type { Phase1Raw } from '../src/seed/phase1-fixtures';

/** Stand-in for the SQL-read Phase 1 fixture values, for tests that build fixtures offline. */
export const SAMPLE_PHASE1_RAW: Phase1Raw = {
  ids: {
    heavyConversation: 'cv_00000000000000000000000000000001',
    message: 'mg_00000000000000000000000000000001',
  },
  search: { conversationName: 'adams', conversationDigits: '5550123' },
  usage: { from: '2026-10-01', to: '2026-10-31' },
  calls: { occurredAt: '2026-01-02T03:04:05.123456Z', id: 'cl_00000000000000000000000000000001' },
  conversations: {
    occurredAt: '2026-01-02T03:04:05.123456Z',
    id: 'cv_00000000000000000000000000000002',
  },
  thread: { occurredAt: '2026-01-02T03:04:05.123456Z', id: 'mg_00000000000000000000000000000002' },
  tasksOpen: {
    due: 'infinity',
    createdAt: '2026-01-02T03:04:05.123456Z',
    id: 'tk_00000000000000000000000000000001',
  },
  tasksDone: {
    completedAt: '2026-01-02T03:04:05.123456Z',
    id: 'tk_00000000000000000000000000000002',
  },
  ledger: { occurredAt: '2026-01-02T03:04:05.123456Z', id: 'le_00000000000000000000000000000001' },
  reconciliations: {
    occurredAt: '2026-01-02T03:04:05.123456Z',
    id: 'rc_00000000000000000000000000000001',
  },
};

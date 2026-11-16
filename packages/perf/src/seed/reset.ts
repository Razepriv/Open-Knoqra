// Pure helpers for `--reset`: what may be reset, and the statements that do it.

/**
 * Tables `--reset` wipes. `audit_event` and `usage_event` have no FK to organization, so CASCADE
 * never reaches them.
 */
export const RESET_TRUNCATE_SQL = 'TRUNCATE "user", organization, audit_event, usage_event CASCADE';

/** Tables the seed loads, analyzed after the bulk load. */
export const ANALYZE_SQL = `ANALYZE contact, contact_permission_event, timeline_event,
  contact_duplicate_dismissal, audit_event, wallet, ledger_entry, phone_number, number_quote,
  number_order, reconciliation_report, usage_event, call, voicemail, channel_connection,
  message_template, conversation, message, message_status_event, task, notification`;

export const EMPTINESS_SQL = `select
  (select count(*) from contact)::text as contacts,
  (select count(*) from "user")::text as users,
  (select count(*) from organization)::text as organizations,
  (select count(*) from audit_event)::text as audit_events`;

export interface RowCounts {
  contacts: number;
  users: number;
  organizations: number;
  auditEvents: number;
}

export function parseCounts(row: Record<string, string> | undefined): RowCounts {
  return {
    contacts: Number(row?.contacts ?? 0),
    users: Number(row?.users ?? 0),
    organizations: Number(row?.organizations ?? 0),
    auditEvents: Number(row?.audit_events ?? 0),
  };
}

export function isPopulated(c: RowCounts): boolean {
  return c.contacts > 0 || c.users > 0 || c.organizations > 0 || c.auditEvents > 0;
}

/** `--reset` truncates every user and organization: only a database named "perf", never with --force. */
export function canReset(database: string): boolean {
  return database.includes('perf');
}

export function describeReset(database: string, c: RowCounts): string {
  return (
    `resetting ${database}: removing ${c.users} users, ${c.organizations} organizations, ` +
    `${c.contacts} contacts and ${c.auditEvents} audit events (and everything cascading from them)`
  );
}

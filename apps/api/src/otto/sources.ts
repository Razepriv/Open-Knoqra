import { CHANNELS, type Channel, currentPermissions, evaluateChannel } from '@knoqra/core';
import {
  contact,
  contactPermissionEvent,
  notification,
  type Tx,
  task,
  timelineEvent,
} from '@knoqra/db';
import { and, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

export interface OttoSource {
  kind: 'contact' | 'timeline' | 'task' | 'notification';
  ref: string;
  /** What the UI shows after "FROM:". Short. */
  label: string;
  /** Fed to the provider. May hold PII: never log it. */
  text: string;
}

const MAX_LABEL = 80;
const TIMELINE_LIMIT = 10;
const LIST_LIMIT = 20;

const KIND_LABELS = {
  note: 'Note',
  consent: 'Consent',
  system: 'Update',
  call: 'Call',
  message: 'Message',
  task: 'Task',
} as const;

const CHANNEL_LABELS: Record<Channel, string> = {
  manual_call: 'Calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  ai_voice: 'AI voice',
  recording: 'Recording',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clip(value: string): string {
  return value.length > MAX_LABEL ? `${value.slice(0, MAX_LABEL - 1)}…` : value;
}
const shortDate = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

interface TimelineLike {
  id: string;
  kind: keyof typeof KIND_LABELS;
  title: string;
  body: string | null;
  occurredAt: Date;
}

function timelineSource(row: TimelineLike, prefix?: string): OttoSource {
  let base = row.title;
  if (row.body) base = row.kind === 'note' ? row.body : `${row.title}: ${row.body}`;
  return {
    kind: 'timeline',
    ref: row.id,
    label: clip(`${KIND_LABELS[row.kind]} · ${shortDate(row.occurredAt)}`),
    text: prefix ? `${prefix}: ${base}` : base,
  };
}

const taskSource = (row: { id: string; title: string }, prefix = 'Task'): OttoSource => ({
  kind: 'task',
  ref: row.id,
  label: clip(`Task · ${row.title}`),
  text: `${prefix}: ${row.title}`,
});

async function consentSummary(tx: Tx, contactId: string): Promise<string> {
  const events = await tx
    .selectDistinctOn([contactPermissionEvent.channel])
    .from(contactPermissionEvent)
    .where(eq(contactPermissionEvent.contactId, contactId))
    .orderBy(
      contactPermissionEvent.channel,
      desc(contactPermissionEvent.createdAt),
      desc(contactPermissionEvent.id),
    );
  const statuses = currentPermissions(events);
  const parts = CHANNELS.map((channel) => {
    const { outcome, reason } = evaluateChannel(channel, statuses[channel]);
    return `${CHANNEL_LABELS[channel]}: ${outcome.replaceAll('_', ' ')} · ${reason.replaceAll('_', ' ')}`;
  });
  return `Consent: ${parts.join('; ')}`;
}

/** The contact's profile line, consent summary, 10 latest timeline events and open tasks. */
export async function contactSources(
  tx: Tx,
  contactId: string,
  userId: string,
): Promise<OttoSource[]> {
  const [row] = await tx.select().from(contact).where(eq(contact.id, contactId)).limit(1);
  if (!row) return [];
  const profile = [row.displayName, row.company, row.jobTitle, ...row.tags]
    .filter((v): v is string => Boolean(v))
    .join(', ');
  const label = clip(`Contact · ${row.displayName}`);
  const sources: OttoSource[] = [
    { kind: 'contact', ref: row.id, label, text: profile },
    { kind: 'contact', ref: row.id, label, text: await consentSummary(tx, contactId) },
  ];
  const events = await tx
    .select()
    .from(timelineEvent)
    .where(eq(timelineEvent.contactId, contactId))
    .orderBy(desc(timelineEvent.occurredAt), desc(timelineEvent.id))
    .limit(TIMELINE_LIMIT);
  sources.push(...events.map((e) => timelineSource(e)));
  const tasks = await tx
    .select({ id: task.id, title: task.title })
    .from(task)
    .where(
      and(eq(task.contactId, contactId), eq(task.ownerUserId, userId), eq(task.status, 'open')),
    )
    .orderBy(sql`coalesce(${task.dueAt}, 'infinity'::timestamptz)`, task.id)
    .limit(LIST_LIMIT);
  sources.push(...tasks.map((t) => taskSource(t)));
  return sources;
}

/** Teammates' timeline events since `since`, unread notifications and overdue tasks. */
export async function digestSources(
  tx: Tx,
  scope: { userId: string },
  since: Date,
): Promise<OttoSource[]> {
  const events = await tx
    .select({
      id: timelineEvent.id,
      kind: timelineEvent.kind,
      title: timelineEvent.title,
      body: timelineEvent.body,
      occurredAt: timelineEvent.occurredAt,
      contactName: contact.displayName,
    })
    .from(timelineEvent)
    .innerJoin(contact, eq(contact.id, timelineEvent.contactId))
    .where(
      and(
        sql`${timelineEvent.createdAt} > ${since.toISOString()}::timestamptz`,
        isNull(contact.archivedAt),
        isNull(contact.mergedIntoId),
        or(isNull(timelineEvent.actorUserId), ne(timelineEvent.actorUserId, scope.userId)),
      ),
    )
    .orderBy(desc(timelineEvent.occurredAt), desc(timelineEvent.id))
    .limit(LIST_LIMIT);
  const unread = await tx
    .select({ id: notification.id, title: notification.title })
    .from(notification)
    .where(and(eq(notification.userId, scope.userId), isNull(notification.readAt)))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(LIST_LIMIT);
  const overdue = await tx
    .select({ id: task.id, title: task.title })
    .from(task)
    .where(
      and(eq(task.ownerUserId, scope.userId), eq(task.status, 'open'), lt(task.dueAt, sql`now()`)),
    )
    .orderBy(task.dueAt, task.id)
    .limit(LIST_LIMIT);
  return [
    ...events.map((e) => timelineSource(e, e.contactName)),
    ...unread.map((n) => ({
      kind: 'notification' as const,
      ref: n.id,
      label: clip(`Notification · ${n.title}`),
      text: n.title,
    })),
    ...overdue.map((t) => taskSource(t, 'Overdue task')),
  ];
}

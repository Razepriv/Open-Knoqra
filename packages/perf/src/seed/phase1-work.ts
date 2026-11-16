// M5 tasks and notifications for the owner. Overdue open tasks already have their `task_due`
// notification, with the exact dedupe key materializeReminders writes, so a notifications poll
// inserts nothing new: the explain case measures the steady state, not a first poll.
import { type ContactRow, WINDOW_END_MS } from './generate';
import { msBetween, type OrgContext, WINDOW_START_MS } from './phase1';
import { hexId, int, pick, type Rand } from './random';
import { TIMELINE_TITLES } from './words';

export interface TaskRow {
  id: string;
  organization_id: string;
  owner_user_id: string;
  contact_id: string | null;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  status: 'open' | 'done';
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  organization_id: string;
  user_id: string;
  kind: 'task_due' | 'task_reminder' | 'system';
  title: string;
  body: string | null;
  ref_type: string | null;
  ref_id: string | null;
  dedupe_key: string;
  read_at: string | null;
  created_at: string;
}

/**
 * Future due dates fall in 2099, so neither a due date nor its reminder (due - 1 h) passes while
 * the seed is in use: a notifications poll would otherwise start materializing reminders and drift
 * the perf database. The date is fixed, not relative to now, so the same seed gives the same rows.
 */
export const FUTURE_START_MS = Date.UTC(2099, 0, 1);
const FUTURE_SPAN_MS = 365 * 86_400_000;
const TASK_TITLES = ['Call back', 'Send the quote', 'Follow up', 'Confirm the meeting', 'Check in'];

function taskRow(
  rand: Rand,
  ctx: OrgContext,
  contactId: string | null,
  contactName: string | null,
): TaskRow {
  const createdMs = msBetween(rand, WINDOW_START_MS, WINDOW_END_MS - 86_400_000);
  const open = rand() < 0.6;
  const r = rand();
  // Open: 30% no due date, 5% overdue (due before the window end), the rest in the future.
  let dueMs: number | null = null;
  if (open && r >= 0.3) {
    dueMs =
      r < 0.35
        ? msBetween(rand, createdMs, WINDOW_END_MS)
        : FUTURE_START_MS + int(rand, FUTURE_SPAN_MS);
  } else if (!open && r < 0.7) {
    dueMs = msBetween(rand, createdMs, WINDOW_END_MS);
  }
  const future = dueMs !== null && dueMs >= FUTURE_START_MS;
  const remindMs = open && future && rand() < 0.2 ? (dueMs as number) - 3_600_000 : null;
  const completedMs = open ? null : msBetween(rand, createdMs, WINDOW_END_MS);
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const created = new Date(createdMs).toISOString();
  return {
    id: hexId(rand, 'tk'),
    organization_id: ctx.orgId,
    owner_user_id: ctx.ownerId,
    contact_id: contactId,
    title: `${pick(rand, TASK_TITLES)}${contactName ? ` ${contactName}` : ''}`,
    notes: rand() < 0.3 ? 'Prepared by the perf seed.' : null,
    due_at: iso(dueMs),
    remind_at: iso(remindMs),
    status: open ? 'open' : 'done',
    completed_at: iso(completedMs),
    created_at: created,
    updated_at: iso(completedMs) ?? created,
  };
}

/** Exactly `total` tasks, `heavy` of them about the heavy contact (selection sampling). */
export function generateTasks(
  rand: Rand,
  ctx: OrgContext,
  total: number,
  heavy: number,
  heavyContact: ContactRow,
  contacts: readonly ContactRow[],
): TaskRow[] {
  const others = contacts.filter((c) => c.id !== heavyContact.id);
  let left = heavy;
  return Array.from({ length: total }, (_, i) => {
    const isHeavy = left > 0 && rand() < left / (total - i);
    if (isHeavy) left--;
    const other = !isHeavy && others.length > 0 && rand() < 0.7 ? pick(rand, others) : null;
    const contact = isHeavy ? heavyContact : other;
    return taskRow(rand, ctx, contact?.id ?? null, contact?.display_name ?? null);
  });
}

/** Open tasks whose due or remind time is before `nowMs`: what materializeReminders would pick. */
export function overdueTasks(tasks: readonly TaskRow[], nowMs: number): TaskRow[] {
  return tasks.filter(
    (t) =>
      t.status === 'open' &&
      ((t.due_at !== null && Date.parse(t.due_at) <= nowMs) ||
        (t.remind_at !== null && Date.parse(t.remind_at) <= nowMs)),
  );
}

/**
 * At least `total` notifications: one `task_due` per overdue open task first (the key
 * materializeReminders writes), then system notifications. Exactly round(total * unreadRatio)
 * are unread.
 */
export function generateNotifications(
  rand: Rand,
  ctx: OrgContext,
  total: number,
  unreadRatio: number,
  tasks: readonly TaskRow[],
): NotificationRow[] {
  const overdue = overdueTasks(tasks, WINDOW_END_MS);
  const n = Math.max(total, overdue.length);
  let unreadLeft = Math.round(n * unreadRatio);
  return Array.from({ length: n }, (_, i) => {
    const unread = unreadLeft > 0 && rand() < unreadLeft / (n - i);
    if (unread) unreadLeft--;
    const task = overdue[i];
    const createdMs = task
      ? Date.parse(task.due_at as string)
      : msBetween(rand, WINDOW_START_MS, WINDOW_END_MS);
    const base = {
      id: hexId(rand, 'nt'),
      organization_id: ctx.orgId,
      user_id: ctx.ownerId,
      body: null,
      read_at: unread ? null : new Date(createdMs + 3_600_000).toISOString(),
      created_at: new Date(createdMs).toISOString(),
    };
    return task
      ? {
          ...base,
          kind: 'task_due' as const,
          title: `Overdue: ${task.title}`,
          ref_type: 'task',
          ref_id: task.id,
          dedupe_key: `due:${task.id}:${new Date(Date.parse(task.due_at as string)).toISOString()}`,
        }
      : {
          ...base,
          kind: 'system' as const,
          title: pick(rand, TIMELINE_TITLES.system as readonly string[]),
          ref_type: null,
          ref_id: null,
          dedupe_key: `perf-system-${i}`,
        };
  });
}

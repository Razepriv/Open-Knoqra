import * as Menu from '@radix-ui/react-dropdown-menu';
import { Link } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { dueLabel } from '../../lib/due';
import type { Task } from '../../lib/tasks';
import { focusRing, iconPill, menuItem, menuSurface } from '../../lib/ui-classes';

export interface TaskRowProps {
  task: Task;
  now: Date;
  timeZone: string;
  /** True while this row's completion is being saved. */
  busy: boolean;
  onToggle: (task: Task) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
}

/** One task: a checkbox, its title and due label, the contact it is about, and an overflow menu. */
export function TaskRow({ task, now, timeZone, busy, onToggle, onEdit, onDelete }: TaskRowProps) {
  const done = task.status === 'done';
  // A plain string: typed route params would be stricter than this link needs.
  const contactHref: string | null = task.contact ? `/contacts/${task.contact.id}` : null;
  return (
    <li className="flex items-center gap-3 rounded-[18px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 py-2.5 [box-shadow:var(--pillShadow)]">
      <input
        type="checkbox"
        aria-label={done ? `Mark ${task.title} open` : `Mark ${task.title} done`}
        checked={done}
        disabled={busy}
        onChange={() => onToggle(task)}
        className={`size-5 shrink-0 cursor-pointer accent-[color:var(--accent)] ${focusRing}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`truncate font-semibold text-[14px] leading-tight ${done ? 'text-[color:var(--muted)] line-through' : ''}`}
        >
          {task.title}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[color:var(--muted)] leading-none">
          {done ? null : (
            <span className="font-[family-name:var(--font-mono)] uppercase tracking-[0.04em]">
              {dueLabel(task, now, timeZone)}
            </span>
          )}
          {contactHref && task.contact ? (
            <Link
              to={contactHref}
              className={`font-medium text-[color:var(--text)] underline ${focusRing}`}
            >
              {task.contact.displayName}
            </Link>
          ) : null}
        </span>
      </span>
      <Menu.Root>
        <Menu.Trigger aria-label={`Actions for ${task.title}`} className={`${iconPill} size-9`}>
          <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={6} className={menuSurface}>
            <Menu.Item onSelect={() => onEdit(task)} className={menuItem}>
              <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
              Edit
            </Menu.Item>
            <Menu.Item onSelect={() => onDelete(task)} className={menuItem}>
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              Delete
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </li>
  );
}

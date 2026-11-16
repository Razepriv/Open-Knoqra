import { isoToLocalInput, localInputToIso } from './due';
import type { Task, UpdateTaskBody } from './tasks';

/** What the edit form holds: the title as typed and `datetime-local` values ('' for none). */
export interface TaskEditForm {
  title: string;
  due: string;
  remind: string;
}

/**
 * The PATCH body for an edit: only the fields the user changed. A time the user left alone is
 * never re-sent, because the form only shows minutes and re-encoding would move a stored time
 * (and re-fire its reminder). `{}` means nothing changed.
 */
export function taskEditPatch(
  task: Pick<Task, 'title' | 'dueAt' | 'remindAt'>,
  form: TaskEditForm,
  timeZone: string,
): UpdateTaskBody {
  const body: UpdateTaskBody = {};
  const title = form.title.trim();
  if (title !== task.title) body.title = title;
  if (form.due !== isoToLocalInput(task.dueAt, timeZone)) {
    body.dueAt = localInputToIso(form.due, timeZone);
  }
  if (form.remind !== isoToLocalInput(task.remindAt, timeZone)) {
    body.remindAt = localInputToIso(form.remind, timeZone);
  }
  return body;
}

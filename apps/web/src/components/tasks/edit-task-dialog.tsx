import { Button } from '@knoqra/ui';
import { type FormEvent, useState } from 'react';
import { isoToLocalInput } from '../../lib/due';
import { taskEditPatch } from '../../lib/task-edit';
import { type Task, taskErrorMessage, useDeleteTask, useUpdateTask } from '../../lib/tasks';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

export interface EditTaskDialogProps {
  task: Task | null;
  timeZone: string;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

export function EditTaskDialog({ task, timeZone, onClose, returnFocus }: EditTaskDialogProps) {
  return (
    <DialogShell
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit task"
      description="Change the title or when it is due."
      initialFocusId="edit-task-title"
      {...(returnFocus ? { returnFocus } : {})}
    >
      {task ? <EditForm key={task.id} task={task} timeZone={timeZone} onDone={onClose} /> : null}
    </DialogShell>
  );
}

function EditForm({
  task,
  timeZone,
  onDone,
}: {
  task: Task;
  timeZone: string;
  onDone: () => void;
}) {
  const update = useUpdateTask();
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(isoToLocalInput(task.dueAt, timeZone));
  const [remind, setRemind] = useState(isoToLocalInput(task.remindAt, timeZone));
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (update.isPending) return;
    const trimmed = title.trim();
    setFormError(null);
    if (!trimmed) {
      setTitleError('Enter a title.');
      return;
    }
    setTitleError(null);
    const body = taskEditPatch(task, { title: trimmed, due, remind }, timeZone);
    if (Object.keys(body).length === 0) {
      onDone();
      return;
    }
    try {
      await update.mutateAsync({ id: task.id, body });
      onDone();
    } catch (error) {
      setFormError(taskErrorMessage(error));
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FormAlert message={formError} />
      <Field
        id="edit-task-title"
        label="Title"
        required
        maxLength={200}
        value={title}
        error={titleError}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Field
        id="edit-task-due"
        label="Due"
        type="datetime-local"
        value={due}
        onChange={(event) => setDue(event.target.value)}
        hint={timeZone}
      />
      <Field
        id="edit-task-remind"
        label="Remind me"
        type="datetime-local"
        value={remind}
        onChange={(event) => setRemind(event.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <DialogCancel />
        <Button type="submit" variant="primary" aria-busy={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

export interface DeleteTaskDialogProps {
  task: Task | null;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

export function DeleteTaskDialog({ task, onClose, returnFocus }: DeleteTaskDialogProps) {
  const remove = useDeleteTask();
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!task || remove.isPending) return;
    setError(null);
    try {
      await remove.mutateAsync(task.id);
      onClose();
    } catch {
      setError('We could not delete this task. Try again in a moment.');
    }
  }

  return (
    <DialogShell
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
      title="Delete task"
      description={task ? `"${task.title}" will be removed. This cannot be undone.` : ''}
      size="sm"
      {...(returnFocus ? { returnFocus } : {})}
    >
      <FormAlert message={error} />
      <div className="mt-4 flex justify-end gap-2">
        <DialogCancel />
        <Button variant="primary" onClick={confirm} aria-busy={remove.isPending}>
          Delete
        </Button>
      </div>
    </DialogShell>
  );
}

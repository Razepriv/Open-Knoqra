import { Button } from '@knoqra/ui';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { localInputToIso } from '../../lib/due';
import { taskErrorMessage, useCreateTask } from '../../lib/tasks';
import { useEffectiveTimeZone } from '../../lib/time-zone';
import { ContactPicker, type PickedContact } from '../contact-picker';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

export interface TaskFormProps {
  /** Focus the title when the form first shows (`/tasks?new=1`). */
  autoFocusTitle?: boolean;
}

export function TaskForm({ autoFocusTitle = false }: TaskFormProps) {
  const timeZone = useEffectiveTimeZone();
  const create = useCreateTask();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [remind, setRemind] = useState('');
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocusTitle) titleRef.current?.focus();
  }, [autoFocusTitle]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    const trimmed = title.trim();
    setFormError(null);
    if (!trimmed) {
      setTitleError('Enter a title.');
      return;
    }
    setTitleError(null);
    const dueAt = localInputToIso(due, timeZone);
    const remindAt = localInputToIso(remind, timeZone);
    try {
      await create.mutateAsync({
        title: trimmed,
        ...(dueAt ? { dueAt } : {}),
        ...(remindAt ? { remindAt } : {}),
        ...(contact ? { contactId: contact.id } : {}),
      });
      setTitle('');
      setDue('');
      setRemind('');
      setContact(null);
      titleRef.current?.focus();
    } catch (error) {
      setFormError(taskErrorMessage(error));
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Add a task" className="flex flex-col gap-4">
      <FormAlert message={formError} />
      <Field
        ref={titleRef}
        id="task-title"
        label="Title"
        required
        maxLength={200}
        value={title}
        error={titleError}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="What needs doing?"
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="task-due"
          label="Due"
          type="datetime-local"
          value={due}
          onChange={(event) => setDue(event.target.value)}
          hint={timeZone}
        />
        <Field
          id="task-remind"
          label="Remind me"
          type="datetime-local"
          value={remind}
          onChange={(event) => setRemind(event.target.value)}
        />
        <ContactPicker label="Contact" value={contact} onChange={setContact} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" aria-busy={create.isPending}>
          Add task
        </Button>
      </div>
    </form>
  );
}

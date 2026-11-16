import { Button } from '@knoqra/ui';
import { type FormEvent, type KeyboardEvent, useState } from 'react';
import { useAddNote } from '../../lib/contact360-queries';
import { haptic } from '../../lib/haptics';
import { focusRing } from '../../lib/ui-classes';
import { useToast } from '../use-toast';

const MAX_NOTE_LENGTH = 4000;

/** Writes an internal note. Ctrl/⌘+Enter submits. Notes are never sent to the contact. */
export function NoteComposer({ contactId }: { contactId: string }) {
  const [text, setText] = useState('');
  const [failed, setFailed] = useState(false);
  const add = useAddNote(contactId);
  const { show, toast } = useToast();
  const empty = text.trim().length === 0;

  async function submit() {
    if (empty || add.isPending) return;
    setFailed(false);
    const sent = text.trim();
    try {
      await add.mutateAsync(sent);
      haptic('success');
      show('Note added.');
      // Keep anything typed while the note was being saved.
      setText((current) => (current.trim() === sent ? '' : current));
    } catch {
      haptic('error');
      setFailed(true);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <textarea
        aria-label="Add a note"
        placeholder="Write a note for your team. It is never sent to the contact."
        value={text}
        maxLength={MAX_NOTE_LENGTH}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        className={`w-full resize-y rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 text-[14px] leading-relaxed outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)] ${focusRing}`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]">
          Internal only · not sent
        </span>
        <span className="flex-1" />
        <span className="hidden text-[12px] text-[color:var(--muted)] sm:inline">
          Ctrl+Enter to add
        </span>
        <Button type="submit" variant="primary" disabled={empty} aria-busy={add.isPending}>
          {add.isPending ? 'Adding…' : 'Add note'}
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
          We could not save the note. Your text is still here. Try again.
        </p>
      ) : null}
      {toast}
    </form>
  );
}

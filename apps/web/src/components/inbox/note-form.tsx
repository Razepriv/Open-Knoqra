import { Button } from '@knoqra/ui';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useAddThreadNote } from '../../lib/inbox';
import { submitOnModEnter } from './composer-reply';

const MAX_NOTE = 4000;

/** An internal note on the thread. It is never sent to the contact. */
export function NoteForm({ conversationId }: { conversationId: string }) {
  const add = useAddThreadNote(conversationId);
  const [body, setBody] = useState('');
  const [failed, setFailed] = useState(false);
  const empty = body.trim() === '';

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || add.isPending) return;
        setFailed(false);
        add.mutate(body, {
          onSuccess: () => setBody(''),
          onError: () => setFailed(true),
        });
      }}
      className="flex flex-col gap-2 rounded-[22px] border-[1.5px] border-[color:var(--muted)] border-dashed bg-[color:var(--cell)] py-[10px] pr-3 pl-[14px] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2"
    >
      {failed ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
          We could not save the note. Try again.
        </p>
      ) : null}
      <textarea
        aria-label="Note"
        rows={2}
        maxLength={MAX_NOTE}
        placeholder="Add an internal note"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={submitOnModEnter}
        className="min-h-[52px] resize-none bg-transparent text-[14px] text-[color:var(--text)] leading-[1.5] outline-none placeholder:text-[color:var(--muted)]"
      />
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-[5px] font-[family-name:var(--font-mono)] font-medium text-[10.5px] text-[color:var(--muted)] tracking-[.04em]">
          <Lock size={11} strokeWidth={2} aria-hidden="true" />
          VISIBLE TO YOUR TEAM ONLY
        </span>
        <span className="flex-1" />
        <Button
          type="submit"
          variant="primary"
          className="h-9 px-4"
          disabled={empty || add.isPending}
          aria-busy={add.isPending}
        >
          Add note
        </Button>
      </div>
    </form>
  );
}

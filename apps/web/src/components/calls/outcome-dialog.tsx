import { Button } from '@knoqra/ui';
import { useState } from 'react';
import { type CallOutcome, callErrorMessage, outcomeLabel, useLogOutcome } from '../../lib/calls';
import { NOTE_MAX, noteHint } from '../../lib/dial';
import { DialogShell } from '../dialog-shell';
import { TextareaField } from '../textarea-field';
import { useToast } from '../use-toast';
import { useCallSession } from './call-session';
import { callName } from './live-call-panel';

const OUTCOMES: readonly CallOutcome[] = [
  'connected',
  'rescheduled',
  'follow_up',
  'voicemail',
  'no_answer',
  'wrong_number',
];

/**
 * Asks how an ended call went: six radio cards, an optional note, Save. Skip closes it and the
 * outcome can still be logged later. Mounted once in the `_app` layout, so it opens on any page.
 */
export function OutcomeDialog() {
  const session = useCallSession();
  const { toast, show } = useToast();
  const call = session.outcomeCall;
  return (
    <>
      {call ? (
        // Keyed by call, so each call starts with a clean choice and note.
        <OutcomeForm
          key={call.id}
          callId={call.id}
          name={call.contact ? call.contact.displayName : null}
          title={callName(call)}
          onDone={(message) => {
            session.closeOutcome();
            if (message) show(message);
          }}
        />
      ) : null}
      {toast}
    </>
  );
}

interface OutcomeFormProps {
  callId: string;
  /** The contact's name, or null for a number that is not a contact. */
  name: string | null;
  /** Who the call was with, for the description. */
  title: string;
  onDone: (toast: string | null) => void;
}

function OutcomeForm({ callId, name, title, onDone }: OutcomeFormProps) {
  const [choice, setChoice] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState('');
  const log = useLogOutcome();

  const save = () => {
    if (!choice) return;
    const trimmed = note.trim();
    log.mutate(
      { id: callId, outcome: choice, ...(trimmed ? { note: trimmed } : {}) },
      {
        onSuccess: () => onDone(name ? `Outcome saved to ${name}'s timeline` : 'Outcome saved'),
      },
    );
  };

  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onDone(null);
      }}
      title="How did it go?"
      description={
        name
          ? `Your call with ${title} has ended. The outcome lands on their timeline.`
          : `Your call with ${title} has ended. Pick an outcome, or skip it for now.`
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Outcome</legend>
          <div className="grid grid-cols-2 gap-2">
            {OUTCOMES.map((outcome) => (
              <label
                key={outcome}
                className="flex h-11 cursor-pointer items-center gap-2 rounded-[22px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-4 font-medium text-[14px] [box-shadow:var(--pillShadow)] has-[:checked]:border-transparent has-[:checked]:bg-[color:var(--accent)] has-[:checked]:text-[color:var(--on-accent)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--line)] has-[:focus-visible]:outline-offset-2"
              >
                <input
                  type="radio"
                  name="call-outcome"
                  value={outcome}
                  checked={choice === outcome}
                  onChange={() => setChoice(outcome)}
                  className="size-4 shrink-0 accent-[color:var(--text)]"
                />
                {outcomeLabel(outcome)}
              </label>
            ))}
          </div>
        </fieldset>
        <TextareaField
          id="outcome-note"
          label="Note"
          hint={noteHint(note.length)}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
        />
        {log.isError ? (
          <p role="alert" className="text-[13px] text-[color:var(--danger-text)] leading-snug">
            {callErrorMessage(log.error)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onDone(null)}>
            Skip
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!choice || log.isPending}
            aria-busy={log.isPending}
          >
            Save
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}

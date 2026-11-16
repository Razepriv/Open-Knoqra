import { Avatar, Button } from '@knoqra/ui';
import { Phone, PhoneOff } from 'lucide-react';
import { useState } from 'react';
import { callErrorMessage, useCancelCall } from '../../lib/calls';
import { formatPhone, gradientFor } from '../../lib/contacts';
import { DialogShell } from '../dialog-shell';
import { type CallSessionError, sessionErrorCopy, useCallSession } from './call-session';
import { callName } from './live-call-panel';

/**
 * Rings on every desk page for an inbound call in `ringing`: Answer, or Decline (the server applies
 * `cancel`). Closing it only hides it here; the call keeps ringing until it is answered or ends.
 */
export function IncomingCall() {
  const session = useCallSession();
  const decline = useCancelCall();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  /** Only this dialog's own Answer failure is shown here, never an unrelated session error. */
  const [failed, setFailed] = useState<{ callId: string; error: CallSessionError } | null>(null);
  const call = session.active;
  if (call?.direction !== 'inbound' || call.state !== 'ringing' || hidden.has(call.id)) {
    return null;
  }
  const answerError = failed?.callId === call.id ? failed.error : null;
  const hide = () => setHidden((ids) => new Set([...ids, call.id]));
  const name = callName(call);
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) hide();
      }}
      title="Incoming call"
      size="sm"
      initialFocusId="incoming-answer"
      description={
        call.contact ? `${name} · ${formatPhone(call.fromE164)}` : 'A number not in your contacts.'
      }
    >
      <div className="flex flex-col items-center gap-4">
        <Avatar
          name={name}
          gradient={gradientFor(call.contact?.id ?? call.fromE164)}
          size={72}
          className="[box-shadow:var(--shadow-avatar)]"
        />
        <p className="font-[family-name:var(--font-display)] text-[22px] leading-none">{name}</p>
        {decline.isError || answerError ? (
          <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
            {decline.isError ? callErrorMessage(decline.error) : null}
            {!decline.isError && answerError ? sessionErrorCopy(answerError) : null}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() => decline.mutate(call.id, { onSuccess: hide })}
            aria-busy={decline.isPending}
          >
            <PhoneOff size={15} strokeWidth={1.75} aria-hidden="true" />
            Decline
          </Button>
          <Button
            id="incoming-answer"
            variant="primary"
            onClick={async () => {
              setFailed(null);
              const error = await session.answer(call.id);
              if (error) setFailed({ callId: call.id, error });
            }}
          >
            <Phone size={15} strokeWidth={1.75} aria-hidden="true" />
            Answer
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

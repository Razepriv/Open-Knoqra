import { Button } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { PhoneOff } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { callErrorMessage } from '../../lib/calls';
import { callStateLine, dialTarget, isLiveState } from '../../lib/dial';
import { type Setup, useUpdateSetup } from '../../lib/setup';
import { useCallSession } from '../calls/call-session';
import { CheckboxField } from '../checkbox-field';
import { Field } from '../field';
import { FormAlert } from '../form-alert';

/** Step 4: place a real call to a phone the person owns, through the same session as the Calls page. */
export function TestCallStep({ setup }: { setup: Setup }) {
  const session = useCallSession();
  const update = useUpdateSetup();
  const [phone, setPhone] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const previousId = useRef<string | null>(null);
  const saved = useRef<string | null>(null);

  const alreadyDone = setup.steps.find((step) => step.id === 'test_call')?.done ?? false;
  const { current } = session;
  const live = current !== null && isLiveState(current.state);

  // The call this step placed is the first new one the session shows after pressing Call.
  useEffect(() => {
    if (armed && current && current.id !== previousId.current && startedId === null) {
      setStartedId(current.id);
    }
  }, [armed, current, startedId]);

  // A failed dial must not leave the step armed to adopt an unrelated later call.
  const dialError = session.error;
  useEffect(() => {
    if (dialError) setArmed(false);
  }, [dialError]);

  const mine = startedId !== null && current?.id === startedId ? current : null;
  const completedId = mine?.state === 'completed' ? mine.id : null;
  const { mutate: saveProgress } = update;
  useEffect(() => {
    if (completedId && saved.current !== completedId) {
      saved.current = completedId;
      saveProgress({ testCallId: completedId });
    }
  }, [completedId, saveProgress]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const to = dialTarget(phone);
    if (!to) {
      setPhoneError('Enter a full number with country code, like +1 202 555 0123.');
      return;
    }
    setPhoneError(null);
    previousId.current = current?.id ?? null;
    setStartedId(null);
    setArmed(true);
    void session.dial({ to, reviewConfirmed: true });
  };

  const reset = () => {
    session.dismiss();
    session.clearError();
    setArmed(false);
    setStartedId(null);
  };

  if (mine && !live) {
    return completedId ? (
      <div className="flex flex-col items-start gap-4">
        <p role="status" className="font-medium text-[16px] leading-snug">
          Test call complete. You're ready to call.
        </p>
        {update.isError ? <FormAlert message="Could not save your setup progress." /> : null}
        <Button variant="ghost" onClick={reset}>
          Call again
        </Button>
      </div>
    ) : (
      <div className="flex flex-col items-start gap-4">
        <p role="status" className="font-medium text-[16px] leading-snug">
          {callStateLine(mine.state, mine.direction)}
        </p>
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    );
  }

  if (mine) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="status" aria-live="polite" className="font-medium text-[16px] leading-snug">
          {callStateLine(mine.state, mine.direction)}
        </p>
        <Button variant="danger" onClick={() => void session.hangup()}>
          <PhoneOff size={15} strokeWidth={1.75} aria-hidden="true" />
          Hang up
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-[440px] flex-col gap-5">
      {alreadyDone ? (
        <p role="status" className="text-[14px] text-[color:var(--muted)] leading-snug">
          Test call complete. You're ready to call.
        </p>
      ) : null}
      <Field
        id="test-call-phone"
        label="A phone you own"
        type="tel"
        autoComplete="off"
        placeholder="+1 202 555 0123"
        required
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={phoneError}
      />
      <CheckboxField
        id="test-call-authorized"
        label="I own this number and I'm authorized to call it"
        required
        checked={authorized}
        onChange={(event) => setAuthorized(event.target.checked)}
      />
      {session.error ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)] leading-snug">
          {callErrorMessage(session.error)}
          {(session.error as { code?: string }).code === 'voice_not_configured' ? (
            <>
              {' '}
              <Link
                to="/setup"
                search={{ step: 'connect' }}
                className="text-[color:var(--text)] underline underline-offset-4"
              >
                Go to Connect Telnyx
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {live && !mine ? (
        <p className="text-[13px] text-[color:var(--muted)]">
          A call is in progress. End it to place the test call.
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        className="self-start"
        disabled={!authorized || !phone.trim() || session.dialing || live}
        aria-busy={session.dialing}
      >
        Call
      </Button>
    </form>
  );
}

import { Button, Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  nextStep,
  SETUP_STEP_LABELS,
  SETUP_STEPS,
  type Setup,
  type SetupStep,
  useUpdateSetup,
} from '../../lib/setup';
import { shouldFocusStepHeading } from '../../lib/setup-focus';
import { focusRing } from '../../lib/ui-classes';
import { AudioStep } from './audio-step';
import { ConnectStep } from './connect-step';
import { NumberStep } from './number-step';
import { TestCallStep } from './test-call-step';

const STEP_BLURBS: Record<SetupStep, string> = {
  connect: 'Save your Telnyx key so KNOQRA can place calls for you.',
  number: 'Pick the number people see, and that receives calls and messages.',
  audio: 'Make sure your microphone and speaker work before the first call.',
  test_call: 'Call a phone you own to confirm everything works end to end.',
};

export interface SetupWizardProps {
  setup: Setup;
  step: SetupStep;
  onStep: (step: SetupStep) => void;
  onClose: () => void;
}

function Stepper({ setup, step, onStep }: Pick<SetupWizardProps, 'setup' | 'step' | 'onStep'>) {
  return (
    <ol aria-label="Setup steps" className="grid gap-2 sm:grid-cols-4">
      {SETUP_STEPS.map((id, index) => {
        const done = setup.steps.find((item) => item.id === id)?.done ?? false;
        const current = id === step;
        return (
          <li key={id}>
            <button
              type="button"
              aria-current={current ? 'step' : undefined}
              onClick={() => onStep(id)}
              className={`flex h-[52px] w-full cursor-pointer items-center gap-3 rounded-[20px] border px-4 text-left font-medium text-[14px] ${focusRing} ${
                current
                  ? 'border-[color:var(--line)] bg-[color:var(--pressed)]'
                  : 'border-[color:var(--panelBorder)] bg-[color:var(--cell)]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`flex size-6 shrink-0 items-center justify-center rounded-full font-[family-name:var(--font-mono)] text-[11px] ${
                  done
                    ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                    : 'bg-[color:var(--pill)]'
                }`}
              >
                {done ? <Check size={13} strokeWidth={2.25} /> : index + 1}
              </span>
              <span>
                {SETUP_STEP_LABELS[id]}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ onClose }: { onClose: () => void }) {
  return (
    <Panel className="flex flex-col gap-4 p-6 sm:p-8">
      <section aria-label="Setup complete" className="flex flex-col gap-4">
        <h2 className="font-[family-name:var(--font-display)] text-[26px] leading-none tracking-[-0.025em]">
          You're set up.
        </h2>
        <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
          Your phone provider is connected, a number is chosen, your audio works and a test call
          went through.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/calls"
            className={`inline-flex h-10 items-center rounded-full bg-[color:var(--accent)] px-4 font-semibold text-[14px] text-[color:var(--on-accent)] ${focusRing}`}
          >
            Go to Calls
          </Link>
          <Link
            to="/numbers"
            className={`inline-flex h-10 items-center rounded-full border border-[color:var(--pillBorder)] px-4 font-semibold text-[14px] ${focusRing}`}
          >
            View Numbers
          </Link>
          <Button variant="ghost" onClick={onClose}>
            Close setup
          </Button>
        </div>
      </section>
    </Panel>
  );
}

/** The four-step first-run wizard: a stepper, the current step, and a summary once all are done. */
export function SetupWizard({ setup, step, onStep, onClose }: SetupWizardProps) {
  const allDone = setup.steps.every((item) => item.done);
  const next = nextStep(step);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<SetupStep | null>(null);
  // Continue/Skip unmount the focused button, so move focus to the new step's heading (not on mount).
  useEffect(() => {
    if (shouldFocusStepHeading(shownStep.current, step)) heading.current?.focus();
    shownStep.current = step;
  }, [step]);
  const advance = () => {
    if (next) onStep(next);
  };
  return (
    <section className="flex flex-1 flex-col gap-4">
      <Panel className="flex flex-col gap-4 p-6 sm:p-9">
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          First-run setup
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(36px,5vw,60px)] leading-[0.98] tracking-[-0.035em]">
          Setup
        </h1>
        <p className="max-w-[52ch] text-[15px] text-[color:var(--muted)] leading-relaxed">
          Four short steps. You can leave and come back; your progress is saved.
        </p>
      </Panel>
      <Stepper setup={setup} step={step} onStep={onStep} />
      {allDone ? <Summary onClose={onClose} /> : null}
      <Panel className="flex flex-col gap-6 p-6 sm:p-8">
        <section aria-labelledby="setup-step-heading" className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h2
              id="setup-step-heading"
              ref={heading}
              tabIndex={-1}
              className="font-[family-name:var(--font-display)] text-[26px] leading-none tracking-[-0.025em] outline-none"
            >
              {SETUP_STEP_LABELS[step]}
            </h2>
            <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
              {STEP_BLURBS[step]}
            </p>
          </header>
          {step === 'connect' ? <ConnectStep setup={setup} onDone={advance} /> : null}
          {step === 'number' ? <NumberStep onDone={advance} /> : null}
          {step === 'audio' ? <AudioStep setup={setup} onDone={advance} /> : null}
          {step === 'test_call' ? <TestCallStep setup={setup} /> : null}
          {next ? (
            <div>
              <Button variant="ghost" onClick={advance}>
                Skip for now
              </Button>
            </div>
          ) : null}
        </section>
      </Panel>
    </section>
  );
}

export function useCloseSetup(onClosed: () => void) {
  const { mutate } = useUpdateSetup();
  return () => mutate({ dismissed: true }, { onSuccess: onClosed });
}

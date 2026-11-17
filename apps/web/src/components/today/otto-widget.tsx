import { TODAY_WIDGET_LABELS } from '@knoqra/core';
import { Reveal } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { FileText, History, PenLine } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import {
  citationHref,
  needsOttoSetup,
  type OttoCitation,
  type OttoDraft,
  ottoErrorMessage,
  ottoEyebrow,
  ottoMood,
  streamOtto,
  useOttoConnection,
} from '../../lib/otto';
import { useTasks } from '../../lib/tasks';
import { focusRing } from '../../lib/ui-classes';
import { ContactPicker, type PickedContact } from '../contact-picker';
import { EarlyAccessTag } from '../otto/early-access-tag';
import { OttoHead } from '../otto/otto-head';
import { OttoResultSkeleton } from '../skeletons/today-skeleton';
import { UP_NEXT_SHOWN } from './up-next-widget';
import { eyebrowClass, WidgetFrame, type WidgetSlotProps } from './widget-frame';

const LABEL = TODAY_WIDGET_LABELS.otto;
const HEAD_SIZE = 116;
const PICKER_LABEL = 'Contact for Otto';

const pill = `inline-flex h-[34px] cursor-pointer items-center gap-[6px] rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[12px] leading-none [box-shadow:var(--pillShadow)] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const small = `inline-flex h-[30px] cursor-pointer items-center rounded-full px-[11px] font-medium text-[12px] leading-none ${focusRing}`;
const mono =
  'font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)]';

/** The first contact among the tasks Up next shows (soonest due first). */
function useUpNextContact(): PickedContact | null {
  const tasks = useTasks('open');
  const shown = tasks.data?.pages[0]?.items.slice(0, UP_NEXT_SHOWN) ?? [];
  const first = shown.find((task) => task.contact);
  return first?.contact ? { id: first.contact.id, displayName: first.contact.displayName } : null;
}

function Citations({
  citations,
  contactId,
}: {
  citations: OttoCitation[];
  contactId: string | null;
}) {
  if (citations.length === 0) return null;
  return (
    <p className={`${mono} leading-[1.5]`}>
      <span>FROM:</span>{' '}
      {citations.map((citation, index) => {
        const href = citationHref(citation, contactId);
        return (
          <Fragment key={`${citation.kind}:${citation.ref}`}>
            {index > 0 ? ', ' : null}
            {href ? (
              <Link to={href} className={`underline underline-offset-2 ${focusRing}`}>
                {citation.label}
              </Link>
            ) : (
              <span>{citation.label}</span>
            )}
          </Fragment>
        );
      })}
    </p>
  );
}

interface ResultCardProps {
  result: OttoDraft;
  onCopy: () => void;
  onDiscard: () => void;
}

function ResultCard({ result, onCopy, onDiscard }: ResultCardProps) {
  return (
    <article
      aria-label="Otto result"
      className="flex flex-col gap-2 rounded-[16px] bg-[color:var(--cell)] px-[14px] py-3"
    >
      <span className={`${mono} leading-none`}>{ottoEyebrow(result)}</span>
      <p className="whitespace-pre-line break-words text-[13px] leading-[1.45]">{result.text}</p>
      <Citations citations={result.citations} contactId={result.contactId} />
      <div className="flex gap-[6px]">
        <button
          type="button"
          onClick={onCopy}
          className={`${small} bg-[color:var(--ink)] font-semibold text-[color:var(--on-ink)]`}
        >
          Copy
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className={`${small} border border-[color:var(--pillBorder)] bg-[color:var(--pill)]`}
        >
          Discard
        </button>
      </div>
    </article>
  );
}

/** Where keyboard focus goes once the widget settles: a given button, or the first action. */
type FocusAfter = HTMLButtonElement | 'first';

/**
 * Puts focus on `target` (or the first enabled action) unless the user has since moved focus to
 * something outside the widget.
 */
function placeFocus(actions: HTMLElement, target: FocusAfter): void {
  const active = document.activeElement;
  const widget = actions.closest('section');
  if (active && active !== document.body && !widget?.contains(active)) return;
  const first = Array.from(actions.querySelectorAll('button')).find((b) => !b.disabled);
  const preferred = target === 'first' ? null : target;
  (preferred?.isConnected && !preferred.disabled ? preferred : first)?.focus();
}

/** Otto on Today: drafts, briefs and a digest from the user's own records. Nothing is sent. */
export function OttoWidget({ controls, notify }: WidgetSlotProps) {
  const upNextContact = useUpNextContact();
  // Until someone picks (or clears) a contact, Otto follows the first one up next.
  const [picked, setPicked] = useState<PickedContact | null | undefined>(undefined);
  const contact = picked === undefined ? upNextContact : picked;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OttoDraft | null>(null);
  // The answer so far, while Otto is still writing it.
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const earlyAccess = useOttoConnection().data?.earlyAccess === true;
  const hintId = useId();
  const actions = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<FocusAfter | null>(null);
  const announcement = result ? `${ottoEyebrow(result)} ready.` : '';

  // The buttons are disabled while Otto works, so focus returns once they are back.
  useEffect(() => {
    const target = focusAfter.current;
    if (busy || !target || !actions.current) return;
    focusAfter.current = null;
    placeFocus(actions.current, target);
  });

  async function run(
    origin: HTMLButtonElement,
    request: (onText: (delta: string) => void) => Promise<OttoDraft>,
  ) {
    setError(null);
    setSetupNeeded(false);
    setResult(null);
    setLive('');
    setBusy(true);
    let next: OttoDraft | null = null;
    let message: string | null = null;
    let setup = false;
    try {
      next = await request((delta) => setLive((text) => text + delta));
    } catch (failure) {
      message = ottoErrorMessage(failure, earlyAccess);
      setup = needsOttoSetup(failure);
    }
    focusAfter.current = origin;
    setResult(next);
    setLive('');
    setError(message);
    setSetupNeeded(setup);
    setBusy(false);
  }

  function ask(kind: 'draft' | 'brief', origin: HTMLButtonElement) {
    if (!contact) return;
    const contactId = contact.id;
    const body =
      kind === 'draft' ? { kind, contactId, channel: 'sms' as const } : { kind, contactId };
    void run(origin, (onText) => streamOtto('/api/v1/otto/drafts/stream', body, onText));
  }

  function discard() {
    focusAfter.current = 'first';
    setResult(null);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Copied.');
    } catch {
      notify("Couldn't copy. Select the text instead.");
    }
  }

  return (
    <WidgetFrame
      widget="otto"
      label={LABEL}
      controls={controls}
      aside={
        <span className="inline-flex flex-wrap items-center justify-end gap-[6px]">
          {earlyAccess ? <EarlyAccessTag /> : null}
          <span className={eyebrowClass('light')}>OTTO · DRAFTS ONLY · METERED</span>
        </span>
      }
    >
      <div className="-mt-1 flex flex-col items-center gap-3 text-center">
        <OttoHead mood={ottoMood({ pending: busy, hasResult: result !== null })} size={HEAD_SIZE} />
        <p className="font-[family-name:var(--font-display)] text-[21px] leading-[1.25] tracking-[-0.01em]">
          I'm Otto. What should we do first?
        </p>
      </div>
      <ContactPicker value={contact} onChange={setPicked} label={PICKER_LABEL} />
      <div ref={actions} className="flex flex-wrap justify-center gap-[6px]">
        <button
          type="button"
          disabled={busy || !contact}
          aria-describedby={contact ? undefined : hintId}
          onClick={(event) => ask('draft', event.currentTarget)}
          className={pill}
        >
          <PenLine size={13} strokeWidth={1.75} aria-hidden="true" />
          Draft a reply
        </button>
        <button
          type="button"
          disabled={busy || !contact}
          aria-describedby={contact ? undefined : hintId}
          onClick={(event) => ask('brief', event.currentTarget)}
          className={pill}
        >
          <FileText size={13} strokeWidth={1.75} aria-hidden="true" />
          Brief me
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(event) =>
            void run(event.currentTarget, (onText) =>
              streamOtto('/api/v1/otto/digest/stream', {}, onText),
            )
          }
          className={pill}
        >
          <History size={13} strokeWidth={1.75} aria-hidden="true" />
          What did I miss
        </button>
      </div>
      {contact ? null : (
        <p id={hintId} className="text-center text-[12px] text-[color:var(--muted)]">
          Pick a contact to draft a reply or get a brief.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)] leading-[1.45]">
          {error}{' '}
          {setupNeeded ? (
            <Link
              to="/settings"
              hash="otto"
              className={`text-[color:var(--ink)] underline underline-offset-2 ${focusRing}`}
            >
              Open Settings
            </Link>
          ) : null}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {busy || result ? (
        <Reveal loading={busy && live === ''}>
          {result ? (
            <ResultCard result={result} onCopy={() => void copy(result.text)} onDiscard={discard} />
          ) : live ? (
            <article
              aria-label="Otto is writing"
              aria-busy="true"
              className="flex flex-col gap-2 rounded-[16px] bg-[color:var(--cell)] px-[14px] py-3"
            >
              <span className={`${mono} leading-none`}>WRITING…</span>
              <p className="whitespace-pre-line break-words text-[13px] leading-[1.45]">{live}</p>
            </article>
          ) : (
            <OttoResultSkeleton label="Otto is thinking" />
          )}
        </Reveal>
      ) : null}
    </WidgetFrame>
  );
}

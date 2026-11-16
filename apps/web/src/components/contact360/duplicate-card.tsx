import { Button } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { type RefObject, useRef, useState } from 'react';
import { type DuplicateSuggestion, duplicateReasonLabel } from '../../lib/contact360';
import { useDismissDuplicate, useDuplicates, useMergeContact } from '../../lib/contact360-queries';
import { formatPhone } from '../../lib/contacts';
import { haptic } from '../../lib/haptics';
import { focusRing, textPill } from '../../lib/ui-classes';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { useToast } from '../use-toast';
import { PERMISSIONS_HEADING_ID } from './consent-panel';

function focusPermissionsHeading() {
  document.getElementById(PERMISSIONS_HEADING_ID)?.focus();
}

export interface DuplicateCardProps {
  contactId: string;
  contactName: string;
}

/** Suggested matches. Nothing merges unless the person confirms; "not the same" is remembered. */
export function DuplicateCards({ contactId, contactName }: DuplicateCardProps) {
  const duplicates = useDuplicates(contactId);
  const items = duplicates.data?.items ?? [];
  // Out here, not in a card: a merged or dismissed card is gone before its toast could be read.
  const { show, toast } = useToast();
  return (
    <>
      {items.map((suggestion) => (
        <DuplicateCard
          key={suggestion.contact.id}
          contactId={contactId}
          contactName={contactName}
          suggestion={suggestion}
          notify={show}
        />
      ))}
      {toast}
    </>
  );
}

interface CardProps extends DuplicateCardProps {
  suggestion: DuplicateSuggestion;
  notify: (message: string) => void;
}

/** The card's Merge button: a text pill, 32px high with a 19px radius in the Desk. */
const reviewButton = textPill.replace('h-[34px]', 'h-8').replace('rounded-full', 'rounded-[19px]');

function DuplicateCard({ contactId, contactName, suggestion, notify }: CardProps) {
  const other = suggestion.contact;
  const dismiss = useDismissDuplicate(contactId);
  const [merging, setMerging] = useState(false);
  const mergeButton = useRef<HTMLButtonElement>(null);
  const [dismissFailed, setDismissFailed] = useState(false);
  // A plain string path: see ContactRow.
  const href: string = `/contacts/${other.id}`;

  // mutateAsync, not mutate's callbacks: the hook's own onSuccess refreshes the list, which can
  // unmount this card before TanStack runs per-call callbacks, and they would be skipped.
  async function onDismiss() {
    if (dismiss.isPending) return;
    setDismissFailed(false);
    try {
      await dismiss.mutateAsync(other.id);
    } catch {
      haptic('error');
      setDismissFailed(true);
      return;
    }
    focusPermissionsHeading();
    haptic('success');
    notify(`Okay, ${other.displayName} is not the same person.`);
  }

  return (
    <fieldset
      aria-label="Suggested match"
      className="m-0 flex min-w-0 flex-col gap-2 rounded-[18px] border-[1.5px] border-[color:var(--muted)] border-dashed px-[14px] py-3"
    >
      <p className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase leading-[1.3] tracking-[.04em]">
        Suggested match · not merged
      </p>
      <p className="text-[13px] leading-[1.45]">
        <Link to={href} className={`font-semibold underline underline-offset-2 ${focusRing}`}>
          {other.displayName}
        </Link>
        {other.company ? ` · ${other.company}` : ''}
        <br />
        <span className="font-[family-name:var(--font-mono)] text-[12px]">
          {formatPhone(other.phoneE164)}
        </span>
        <br />
        <span className="text-[color:var(--muted)]">
          {suggestion.reasons.map(duplicateReasonLabel).join(' · ')}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-[6px]">
        <button
          ref={mergeButton}
          type="button"
          aria-label={`Merge ${other.displayName}`}
          className={reviewButton}
          onClick={() => setMerging(true)}
        >
          Merge
        </button>
        <button
          type="button"
          aria-label={`${other.displayName} is not the same person`}
          disabled={dismiss.isPending}
          aria-busy={dismiss.isPending}
          onClick={() => void onDismiss()}
          className={`h-8 cursor-pointer px-2 font-medium text-[12px] underline disabled:opacity-50 ${focusRing}`}
        >
          {dismiss.isPending ? 'Saving…' : 'Not the same person'}
        </button>
      </div>
      {dismissFailed ? (
        <p role="alert" className="text-[12px] text-[color:var(--danger-text)]">
          We could not save that. Try again.
        </p>
      ) : null}
      <MergeDialog
        contactId={contactId}
        contactName={contactName}
        other={other}
        open={merging}
        onOpenChange={setMerging}
        mergeButton={mergeButton}
        notify={notify}
      />
    </fieldset>
  );
}

interface MergeDialogProps {
  contactId: string;
  contactName: string;
  other: DuplicateSuggestion['contact'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Merge button that opened the dialog: cancelling returns focus there. */
  mergeButton: RefObject<HTMLElement | null>;
  notify: (message: string) => void;
}

function MergeDialog({
  contactId,
  contactName,
  other,
  open,
  onOpenChange,
  mergeButton,
  notify,
}: MergeDialogProps) {
  const merge = useMergeContact(contactId);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const merged = useRef(false);

  async function confirm() {
    if (busy) return;
    haptic('warning');
    setBusy(true);
    setFailed(false);
    try {
      await merge.mutateAsync(other.id);
      merged.current = true;
      haptic('success');
      notify(`Merged ${other.displayName} into ${contactName}.`);
      // The card may unmount before the dialog finishes closing, so move focus now as well.
      focusPermissionsHeading();
      setBusy(false);
      onOpenChange(false);
    } catch {
      setBusy(false);
      haptic('error');
      setFailed(true);
    }
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Merge contacts"
      size="sm"
      // Only a finished merge moves focus away: the card is gone, so it goes to a stable heading.
      returnFocus={() =>
        merged.current ? document.getElementById(PERMISSIONS_HEADING_ID) : mergeButton.current
      }
      description={
        <>
          {`Merge ${other.displayName} into ${contactName}? `}
          Notes, consent history and timeline move to this contact. The other record is archived.
        </>
      }
    >
      {failed ? (
        <p role="alert" className="mb-3 text-[13px] text-[color:var(--danger-text)]">
          We could not merge these contacts. Nothing changed. Try again.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <DialogCancel />
        <Button
          variant="primary"
          disabled={busy}
          aria-busy={merge.isPending}
          onClick={() => void confirm()}
        >
          {busy ? 'Merging…' : 'Merge contacts'}
        </Button>
      </div>
    </DialogShell>
  );
}

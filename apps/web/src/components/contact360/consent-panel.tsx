import { Button, Skeleton, StatusDot } from '@knoqra/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Info } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  liftReasonError,
  liftsDoNotContact,
  MAX_REASON_LENGTH,
  REASON_REQUIRED_CODE,
  reasonCount,
} from '../../lib/consent-reason';
import {
  CHANNEL_ORDER,
  type Channel,
  type ChannelPermission,
  channelLabel,
  consentSourceLabel,
  decisionCopy,
  decisionTone,
  statusLabel,
} from '../../lib/contact360';
import {
  type PermissionStatus,
  permissionFor,
  useDoNotContact,
  usePermissions,
  useSetPermission,
} from '../../lib/contact360-queries';
import { relativeTime } from '../../lib/format';
import { haptic } from '../../lib/haptics';
import { iconPill, menuItem, menuSurface, textPill } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { ConsentRowSkeleton } from '../skeletons/contact360-skeleton';
import { QueryStatePanel } from '../states/state-panel';
import { TextareaField } from '../textarea-field';
import { useToast } from '../use-toast';

/** Where focus goes when the control that was focused is replaced (merge, dismiss). */
export const PERMISSIONS_HEADING_ID = 'permissions-heading';

export type ChangeAction = PermissionStatus | 'do_not_contact';

export interface PendingChange {
  channel: Channel;
  action: ChangeAction;
  /** The channel's status when the change was chosen: granting over do not contact lifts it. */
  current: ChannelPermission['status'] | undefined;
}

const ACTIONS: readonly { action: ChangeAction; menu: string }[] = [
  { action: 'granted', menu: 'Grant consent' },
  { action: 'revoked', menu: 'Revoke consent' },
  { action: 'opted_out', menu: 'Opted out' },
  { action: 'do_not_contact', menu: 'Do not contact' },
];

export interface ConsentPanelProps {
  contactId: string;
  contactName: string;
  /** Archived and merged contacts show consent but cannot change it. */
  readOnly: boolean;
}

/** Permissions per channel. Every decision shown here was made by the server. */
export function ConsentPanel({ contactId, contactName, readOnly }: ConsentPanelProps) {
  const permissions = usePermissions(contactId);
  const now = useNow(60_000);
  const [pending, setPending] = useState<PendingChange | null>(null);
  // The menu button that opened the dialog: it gets focus back, since the menu item is gone.
  const opener = useRef<HTMLElement | null>(null);
  const failedFirstLoad = permissions.isError && !permissions.data;
  const refreshFailed = permissions.isError && Boolean(permissions.data);
  // Lives here, not in the dialog: the dialog unmounts as it closes on success.
  const { show, toast } = useToast();

  return (
    <div className="flex flex-col gap-3">
      <h2
        id={PERMISSIONS_HEADING_ID}
        tabIndex={-1}
        className="font-[family-name:var(--font-display)] font-medium text-[18px] leading-none outline-none"
      >
        Permissions
      </h2>
      <p className="text-[12.5px] text-[color:var(--muted)] leading-[1.45]">
        Each channel is assessed on its own. A published number is not consent.
      </p>
      {refreshFailed ? (
        <div role="status" className="flex flex-col items-start gap-2">
          <p className="text-[12.5px] text-[color:var(--danger-text)] leading-[1.4]">
            Couldn't refresh consent; showing last known.
          </p>
          <button type="button" className={textPill} onClick={() => void permissions.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {failedFirstLoad ? (
        <QueryStatePanel
          error={permissions.error}
          onRetry={() => void permissions.refetch()}
          retrying={permissions.isFetching}
          subject="this contact's permissions"
          headingLevel={3}
        />
      ) : (
        <ul className="flex flex-col gap-[6px]">
          {CHANNEL_ORDER.map((channel) => {
            const permission = permissionFor(permissions.data?.channels, channel);
            return (
              <ConsentRow
                key={channel}
                channel={channel}
                permission={permission}
                loading={permissions.isPending}
                readOnly={readOnly}
                now={now}
                onChange={(action, trigger) => {
                  opener.current = trigger;
                  setPending({ channel, action, current: permission?.status });
                }}
              />
            );
          })}
        </ul>
      )}
      <ConsentChangeDialog
        contactId={contactId}
        contactName={contactName}
        pending={pending}
        onClose={() => setPending(null)}
        returnFocus={() => opener.current}
        onSaved={show}
      />
      {toast}
    </div>
  );
}

interface ConsentRowProps {
  channel: Channel;
  permission: ChannelPermission | undefined;
  loading: boolean;
  readOnly: boolean;
  now: Date;
  onChange: (action: ChangeAction, trigger: HTMLElement | null) => void;
}

/**
 * One channel, compact: its name and the server's decision on one line, then one line of why. The
 * evidence and where the decision was recorded open below on request.
 */
function ConsentRow({ channel, permission, loading, readOnly, now, onChange }: ConsentRowProps) {
  const label = channelLabel(channel);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  return (
    <li className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-[13px] leading-[1.2]">{label}</span>
        {/* 24px controls (the WCAG 2.2 minimum target) fit the name and decision on one line. */}
        <span className="-my-1 flex shrink-0 items-center gap-0.5 whitespace-nowrap">
          {permission ? (
            <StatusDot
              status={decisionTone(permission.decision.outcome)}
              label={statusLabel(permission.decision.outcome)}
            />
          ) : loading ? (
            <Skeleton width={72} height={12} label={`Loading ${label} permission`} />
          ) : (
            <StatusDot status="none" label="Unknown" />
          )}
          {permission ? (
            <button
              type="button"
              aria-expanded={details}
              aria-controls={detailsId}
              aria-label={`${label} consent details`}
              title={details ? 'Hide details' : 'Show details'}
              onClick={() => setDetails((open) => !open)}
              className={`${iconPill} size-6 border-transparent bg-transparent [box-shadow:none]`}
            >
              <Info size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : null}
          {readOnly ? null : <ChangeMenu label={label} disabled={loading} onSelect={onChange} />}
        </span>
      </div>
      {/* Loading keeps the row's two lines, so the rows below do not move when it lands. */}
      {!permission && loading ? <ConsentRowSkeleton /> : null}
      {permission ? (
        <>
          <p className="text-[12px] text-[color:var(--muted)] leading-[1.35]">
            {decisionCopy(channel, permission.decision.reason)}
          </p>
          <div id={detailsId} hidden={!details} className="flex flex-col gap-1">
            {permission.evidence ? (
              <p className="break-words text-[12px] leading-[1.35]">{`"${permission.evidence}"`}</p>
            ) : null}
            <p className="font-[family-name:var(--font-mono)] text-[10.5px] text-[color:var(--muted)] leading-[1.5]">
              {consentSourceLabel(permission.source)}
              {permission.updatedAt ? ` · updated ${relativeTime(permission.updatedAt, now)}` : ''}
            </p>
          </div>
        </>
      ) : null}
    </li>
  );
}

function ChangeMenu(props: {
  label: string;
  disabled: boolean;
  onSelect: (action: ChangeAction, trigger: HTMLElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger
        ref={trigger}
        disabled={props.disabled}
        aria-label={`Change ${props.label} consent`}
        title={`Change ${props.label} consent`}
        className={`${iconPill} size-6 border-transparent bg-transparent [box-shadow:none] disabled:opacity-50`}
      >
        <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" sideOffset={6} className={menuSurface}>
          {ACTIONS.map(({ action, menu }) => (
            <Menu.Item
              key={action}
              onSelect={() => props.onSelect(action, trigger.current)}
              className={menuItem}
            >
              {menu}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const CONFIRM_LABEL: Record<ChangeAction, string> = {
  granted: 'Grant consent',
  revoked: 'Revoke consent',
  opted_out: 'Record opt-out',
  do_not_contact: 'Mark do not contact',
};

const TITLE_PREFIX: Record<ChangeAction, string> = {
  granted: 'Grant consent',
  revoked: 'Revoke consent',
  opted_out: 'Record opt-out',
  do_not_contact: 'Do not contact',
};

interface ChangeDialogProps {
  contactId: string;
  contactName: string;
  pending: PendingChange | null;
  onClose: () => void;
  returnFocus: () => HTMLElement | null | undefined;
  /** Told what was saved, once the server confirms it (the panel shows it as a toast). */
  onSaved?: (message: string) => void;
}

/** What a saved change says, for the confirmation toast. */
function savedMessage(change: PendingChange, contactName: string, lifted: boolean): string {
  const channel = channelLabel(change.channel);
  if (change.action === 'do_not_contact') return `${contactName} is marked do not contact.`;
  if (lifted) return `Do not contact lifted. ${channel} consent granted.`;
  if (change.action === 'granted') return `${channel} consent granted.`;
  if (change.action === 'revoked') return `${channel} consent revoked.`;
  return `${channel} opt-out recorded.`;
}

/** Exported for its unit test; the panel is its only caller. */
export function ConsentChangeDialog({
  contactId,
  contactName,
  pending,
  onClose,
  returnFocus,
  onSaved,
}: ChangeDialogProps) {
  // Radix keeps the content mounted while it closes, so remember what it was showing.
  const shown = useRef<PendingChange | null>(null);
  if (pending) shown.current = pending;
  const current = pending ?? shown.current;
  const isDnc = current?.action === 'do_not_contact';
  const lifting = current ? liftsDoNotContact(current.current, current.action) : false;
  const title = !current
    ? ''
    : isDnc
      ? `Do not contact ${contactName}?`
      : lifting
        ? `Lift do not contact: ${channelLabel(current.channel)}`
        : `${TITLE_PREFIX[current.action]}: ${channelLabel(current.channel)}`;
  return (
    <DialogShell
      open={pending !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={title}
      size="sm"
      returnFocus={returnFocus}
      description={
        isDnc
          ? `This blocks every channel for ${contactName}: calls, SMS, WhatsApp, AI voice and recording. The change is recorded in their history.`
          : lifting && current
            ? `${contactName} is marked do not contact on ${channelLabel(current.channel)}. Granting consent lifts that, so say how they gave consent again. The reason is recorded in their history.`
            : 'The change is recorded in their history, with your note if you add one.'
      }
    >
      {pending ? (
        <ConsentChangeForm
          contactId={contactId}
          contactName={contactName}
          pending={pending}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </DialogShell>
  );
}

function ConsentChangeForm({
  contactId,
  contactName,
  pending,
  onClose,
  onSaved,
}: {
  contactId: string;
  contactName: string;
  pending: PendingChange;
  onClose: () => void;
  onSaved: ((message: string) => void) | undefined;
}) {
  const set = useSetPermission(contactId);
  const dnc = useDoNotContact(contactId);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const isDnc = pending.action === 'do_not_contact';
  // Also true once the server says the channel is do not contact (the panel was out of date).
  const [lifting, setLifting] = useState(() => liftsDoNotContact(pending.current, pending.action));

  async function confirm() {
    if (done) return;
    setFailed(false);
    const note = text.trim() || undefined;
    if (lifting) {
      const error = liftReasonError(text);
      setFieldError(error);
      if (error) return;
    }
    setDone(true);
    // Confirming changes what this contact may receive: a warning tap, then the result's own.
    haptic('warning');
    try {
      if (pending.action === 'do_not_contact') {
        await dnc.mutateAsync(note);
      } else {
        await set.mutateAsync({
          channel: pending.channel,
          status: pending.action,
          ...(note ? (lifting ? { reason: note } : { evidence: note }) : {}),
        });
      }
      haptic('success');
      onSaved?.(savedMessage(pending, contactName, lifting));
      onClose();
    } catch (error) {
      haptic('error');
      setDone(false);
      // The server's own words about the reason belong on the field, not in a general alert.
      if (error instanceof ApiError && isReasonRejection(error)) {
        setLifting(true);
        setFieldError(error.message);
      } else {
        setFailed(true);
      }
    }
  }

  return (
    <>
      {lifting ? (
        <TextareaField
          id="consent-reason"
          label="Reason"
          required
          hint="How did they give consent again? 5 to 500 characters."
          counter={reasonCount(text)}
          maxLength={MAX_REASON_LENGTH}
          error={fieldError}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
      ) : (
        <TextareaField
          id="consent-evidence"
          label="Evidence (optional)"
          hint="Where this came from, for your records. Up to 500 characters."
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      {failed ? (
        <p role="alert" className="mt-3 text-[13px] text-[color:var(--danger-text)]">
          We could not save this change. Nothing was recorded. Try again.
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <DialogCancel />
        <Button
          variant={isDnc ? 'danger' : 'primary'}
          disabled={done}
          aria-busy={set.isPending || dnc.isPending}
          onClick={() => void confirm()}
        >
          {done ? 'Saving…' : lifting ? 'Lift and grant consent' : CONFIRM_LABEL[pending.action]}
        </Button>
      </div>
    </>
  );
}

/** A 422 for a missing reason, or a 400 about the reason field itself. */
function isReasonRejection(error: ApiError): boolean {
  if (error.code === REASON_REQUIRED_CODE) return true;
  return error.status === 400 && error.message.startsWith('reason');
}

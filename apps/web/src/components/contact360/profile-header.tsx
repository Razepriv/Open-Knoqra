import { Avatar, Button, ButtonLink, Panel } from '@knoqra/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { createLink, Link } from '@tanstack/react-router';
import {
  Archive,
  Ban,
  Clock,
  Mail,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Phone,
  RotateCcw,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  blockedPillText,
  type Channel,
  type ChannelPermission,
  readOnlyMessageReason,
} from '../../lib/contact360';
import { permissionFor, useArchiveContact, useRestoreContact } from '../../lib/contact360-queries';
import { type Contact, formatPhone, gradientFor, localTimeIn } from '../../lib/contacts';
import { profileHeaderLayout } from '../../lib/contacts-layout';
import { haptic } from '../../lib/haptics';
import { focusRing, iconPill, menuItem, menuSurface } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { useToast } from '../use-toast';
import { EditContactDialog } from './edit-contact-dialog';

export interface ProfileHeaderProps {
  contact: Contact;
  permissions: readonly ChannelPermission[] | undefined;
}

const chip =
  'inline-flex h-7 items-center gap-[5px] rounded-[14px] bg-[color:var(--cell)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px] whitespace-nowrap';

interface PillSpec {
  channel: Channel;
  label: string;
  Icon: typeof Phone;
}

// Desk v2 stacks them Call, WhatsApp, SMS in a column at the right of the header.
const CALL_PILL: PillSpec = { channel: 'manual_call', label: 'Call', Icon: Phone };

const MESSAGE_PILLS: readonly (PillSpec & { channel: 'sms' | 'whatsapp' })[] = [
  { channel: 'whatsapp', label: 'WhatsApp', Icon: MessageCircle },
  { channel: 'sms', label: 'SMS', Icon: MessageSquare },
];

// 130px wide (grows for a longer blocked reason), Call 40px high, the others 38px.
const pillBase =
  'inline-flex min-w-[130px] items-center justify-center gap-[7px] rounded-full px-[14px] text-center font-medium text-[13px]';
const pillHeight = (channel: Channel) => (channel === 'manual_call' ? 'min-h-10' : 'min-h-[38px]');
const blockedPill = (channel: Channel) =>
  `${pillBase} ${pillHeight(channel)} border-[1.5px] border-[color:var(--muted)] border-dashed py-1 text-[color:var(--muted)]`;

/** The lime primary Button, as a router link. */
const PrimaryLink = createLink(ButtonLink);

function BlockedLabel({ text }: { text: string }) {
  return (
    <>
      <Ban size={15} strokeWidth={1.75} aria-hidden="true" />
      {text}
    </>
  );
}

/** Call opens the dialer for this contact. A blocked channel says so, from the server. */
function CallPill({
  contactId,
  permission,
}: {
  contactId: string;
  permission?: ChannelPermission;
}) {
  const blocked = blockedPillText(CALL_PILL.channel, permission);
  if (blocked) {
    return (
      <span className={blockedPill(CALL_PILL.channel)}>
        <BlockedLabel text={blocked} />
      </span>
    );
  }
  return (
    <PrimaryLink
      variant="primary"
      to="/calls"
      search={{ contactId }}
      className="min-w-[130px] font-medium text-[13px]"
    >
      <Phone size={15} strokeWidth={1.75} aria-hidden="true" />
      {CALL_PILL.label}
    </PrimaryLink>
  );
}

/**
 * SMS and WhatsApp on an archived or merged contact: there is no thread to open (the API refuses),
 * so the pill stays reachable but disabled, and says why on screen, in its tooltip and to screen
 * readers.
 */
function ReadOnlyMessagePill({
  spec,
  reason,
}: {
  spec: (typeof MESSAGE_PILLS)[number];
  reason: { short: string; full: string };
}) {
  const reasonId = `pill-${spec.channel}-read-only`;
  return (
    <>
      <button
        type="button"
        aria-disabled="true"
        aria-describedby={reasonId}
        title={reason.full}
        className={`${blockedPill(spec.channel)} cursor-not-allowed ${focusRing}`}
      >
        <BlockedLabel text={`${spec.label} · ${reason.short}`} />
      </button>
      <span id={reasonId} className="sr-only">
        {reason.full}
      </span>
    </>
  );
}

/**
 * SMS and WhatsApp open the contact's thread in the Inbox. A blocked channel keeps its blocked
 * look but still links there, because the Inbox explains why and how to unblock it. An archived
 * or merged contact has no thread to open: see ReadOnlyMessagePill.
 */
function MessagePill({
  spec,
  contactId,
  permission,
}: {
  spec: (typeof MESSAGE_PILLS)[number];
  contactId: string;
  permission?: ChannelPermission;
}) {
  const blocked = blockedPillText(spec.channel, permission);
  const { Icon } = spec;
  return (
    <Link
      to="/inbox"
      search={{ contact: contactId, channel: spec.channel }}
      className={`${
        blocked
          ? blockedPill(spec.channel)
          : `${pillBase} ${pillHeight(spec.channel)} border border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)]`
      } ${focusRing}`}
    >
      {blocked ? (
        <BlockedLabel text={blocked} />
      ) : (
        <>
          <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
          {spec.label}
        </>
      )}
    </Link>
  );
}

export function ProfileHeader({ contact, permissions }: ProfileHeaderProps) {
  const now = useNow(60_000);
  const [editing, setEditing] = useState(false);
  const { show, toast } = useToast();
  const archive = useArchiveContact(contact.id);
  const restore = useRestoreContact(contact.id);
  const archived = contact.archivedAt !== null;
  const merged = contact.mergedIntoId !== null;
  const time = localTimeIn(contact.timezone, now);
  const subtitle = [contact.jobTitle, contact.company].filter(Boolean).join(' · ');

  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const archiving = archive.isPending || restore.isPending;
  const fail = () => {
    haptic('error');
    show('We could not update this contact. Try again.');
  };
  const toggleArchive = () => {
    if (archiving) return;
    if (!archived) {
      setConfirmingArchive(true);
      return;
    }
    restore.mutate(undefined, {
      onSuccess: () => {
        haptic('success');
        show(`Restored ${contact.displayName}.`);
      },
      onError: fail,
    });
  };
  const confirmArchive = () => {
    setConfirmingArchive(false);
    haptic('warning');
    archive.mutate(undefined, {
      onSuccess: () => {
        haptic('success');
        show(`Archived ${contact.displayName}.`);
      },
      onError: fail,
    });
  };

  return (
    <Panel data-anchor="profile-header" className={profileHeaderLayout.panel}>
      <Avatar
        name={contact.displayName}
        gradient={gradientFor(contact.id)}
        size={84}
        className="[box-shadow:var(--shadow-avatar)]"
      />
      <div className={profileHeaderLayout.main}>
        <div className={profileHeaderLayout.titleRow}>
          <h1 className="break-words font-[family-name:var(--font-display)] text-[clamp(26px,3vw,34px)] leading-none tracking-[-0.03em]">
            {contact.displayName}
          </h1>
          <Menu.Root>
            <Menu.Trigger
              ref={moreButton}
              aria-label="More actions"
              title="More actions"
              className={`${iconPill} size-10 shrink-0 self-start`}
            >
              <MoreHorizontal size={17} strokeWidth={1.75} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content align="end" sideOffset={8} className={menuSurface}>
                <Menu.Item
                  disabled={merged || archived}
                  onSelect={() => setEditing(true)}
                  className={menuItem}
                >
                  <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
                  Edit contact
                </Menu.Item>
                <Menu.Item
                  disabled={merged || archiving}
                  aria-busy={archiving}
                  onSelect={toggleArchive}
                  className={menuItem}
                >
                  {archived ? (
                    <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                  ) : (
                    <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {archiving
                    ? archived
                      ? 'Restoring…'
                      : 'Archiving…'
                    : archived
                      ? 'Restore contact'
                      : 'Archive contact'}
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
        {subtitle ? (
          <p className="text-[14px] text-[color:var(--muted)] leading-[1.3]">{subtitle}</p>
        ) : null}
        <div className={profileHeaderLayout.chips}>
          <span className={chip}>
            <Phone size={12} strokeWidth={1.75} aria-hidden="true" />
            {formatPhone(contact.phoneE164)}
          </span>
          {contact.email ? (
            <span className={chip}>
              <Mail size={12} strokeWidth={1.75} aria-hidden="true" />
              {contact.email}
            </span>
          ) : null}
          {time && contact.timezone ? (
            <span className={chip}>
              <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
              {`Local time ${time} · ${contact.timezone}`}
            </span>
          ) : null}
          {contact.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-7 items-center rounded-[14px] border border-[color:var(--muted)] px-[10px] font-medium text-[12px]"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div data-anchor="profile-actions" className={profileHeaderLayout.actions}>
        <CallPill
          contactId={contact.id}
          permission={permissionFor(permissions, CALL_PILL.channel)}
        />
        {MESSAGE_PILLS.map((spec) => {
          const readOnly = readOnlyMessageReason(contact);
          return readOnly ? (
            <ReadOnlyMessagePill key={spec.channel} spec={spec} reason={readOnly} />
          ) : (
            <MessagePill
              key={spec.channel}
              spec={spec}
              contactId={contact.id}
              permission={permissionFor(permissions, spec.channel)}
            />
          );
        })}
      </div>
      <DialogShell
        open={confirmingArchive}
        onOpenChange={setConfirmingArchive}
        title={`Archive ${contact.displayName}?`}
        size="sm"
        returnFocus={() => moreButton.current}
        description="They leave your contact lists and cannot be changed until you restore them. Notes and consent history are kept."
      >
        <div className="flex justify-end gap-2">
          <DialogCancel />
          <Button variant="primary" onClick={confirmArchive}>
            Archive
          </Button>
        </div>
      </DialogShell>
      <EditContactDialog
        contact={contact}
        open={editing}
        onOpenChange={setEditing}
        returnFocus={() => moreButton.current}
      />
      {toast}
    </Panel>
  );
}

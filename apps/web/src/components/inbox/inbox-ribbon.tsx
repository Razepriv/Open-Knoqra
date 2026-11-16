import { Avatar, Panel, Skeleton, StatusDot } from '@knoqra/ui';
import { Phone } from 'lucide-react';
import {
  type Channel,
  type ChannelPermission,
  channelLabel,
  decisionCopy,
  decisionTone,
  statusLabel,
} from '../../lib/contact360';
import { permissionFor, usePermissions } from '../../lib/contact360-queries';
import { gradientFor } from '../../lib/contacts';
import type { ConversationDetail, RegistrationStatus } from '../../lib/inbox';
import { senderSummary } from '../../lib/inbox-format';
import { LiveSenderControl, REGISTRATION_LABEL } from './live-sender-control';
import { WindowCard } from './window-card';

const mono =
  'font-[family-name:var(--font-mono)] font-medium text-[11px] leading-[1.3] tracking-[.04em] text-[color:var(--muted)]';

const REGISTRATION_TONE: Record<RegistrationStatus, 'ok' | 'warn' | 'bad'> = {
  approved: 'ok',
  pending: 'warn',
  not_started: 'warn',
  rejected: 'bad',
};

const MESSAGING_CHANNELS: readonly Channel[] = ['sms', 'whatsapp'];

export interface InboxRibbonProps {
  conversation: ConversationDetail;
  now: Date;
}

/** The thread's context: who, the WhatsApp window, the sender, and messaging consent. */
export function InboxRibbon({ conversation, now }: InboxRibbonProps) {
  const { contact, channel, composer, sender } = conversation;
  const summary = sender ? senderSummary(sender) : null;
  return (
    <Panel className="flex flex-1 flex-col gap-3 overflow-auto p-[18px]">
      <div className="flex flex-col items-center gap-2 pt-1 pb-[6px] text-center">
        <Avatar
          name={contact.displayName}
          gradient={gradientFor(contact.id)}
          size={72}
          className="[box-shadow:var(--shadow-avatar)]"
        />
        <h2 className="font-[family-name:var(--font-display)] font-medium text-[21px] leading-[1.1] tracking-[-0.01em]">
          {contact.displayName}
        </h2>
        {contact.company ? (
          <span className="text-[13px] text-[color:var(--muted)]">{contact.company}</span>
        ) : null}
        <span className="flex h-7 items-center gap-[5px] rounded-full bg-[color:var(--cell)] px-[10px] font-[family-name:var(--font-mono)] font-medium text-[11px]">
          <Phone size={12} strokeWidth={1.75} aria-hidden="true" />
          {contact.phone}
        </span>
      </div>

      {channel === 'whatsapp' ? <WindowCard composer={composer} now={now} /> : null}

      <h2 className={mono}>SENDING FROM</h2>
      <div className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]">
        {sender && summary ? (
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-semibold text-[13px] leading-[1.2]">
              {summary.title}
            </span>
            <StatusDot
              status={REGISTRATION_TONE[sender.registrationStatus]}
              label={REGISTRATION_LABEL[sender.registrationStatus]}
              className="shrink-0 text-[12px]"
            />
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-[13px] leading-[1.2]">No sender connected</span>
            <StatusDot status="none" label="None" className="text-[12px]" />
          </div>
        )}
        {summary ? (
          <p className="text-[12px] text-[color:var(--muted)] leading-[1.35]">{summary.note}</p>
        ) : null}
        <LiveSenderControl channel={channel} />
      </div>

      <h2 className={mono}>PERMISSIONS BY CHANNEL</h2>
      <MessagingConsent contactId={contact.id} />
    </Panel>
  );
}

function MessagingConsent({ contactId }: { contactId: string }) {
  const permissions = usePermissions(contactId);
  if (permissions.isError && !permissions.data) {
    return (
      <p role="alert" className="text-[12.5px] text-[color:var(--danger-text)]">
        We could not load permissions.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-[6px]">
      {MESSAGING_CHANNELS.map((channel) => (
        <ConsentRow
          key={channel}
          channel={channel}
          permission={permissionFor(permissions.data?.channels, channel)}
          loading={permissions.isPending}
        />
      ))}
    </ul>
  );
}

/** A read-only mirror of the contact 360 consent row. Changes happen on the contact. */
function ConsentRow(props: {
  channel: Channel;
  permission: ChannelPermission | undefined;
  loading: boolean;
}) {
  const label = channelLabel(props.channel);
  const { permission } = props;
  return (
    <li className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-[13px] leading-[1.2]">{label}</span>
        {permission ? (
          <StatusDot
            status={decisionTone(permission.decision.outcome)}
            label={statusLabel(permission.decision.outcome)}
            className="text-[12px]"
          />
        ) : props.loading ? (
          <Skeleton width={72} height={12} label={`Loading ${label} permission`} />
        ) : (
          <StatusDot status="none" label="Unknown" className="text-[12px]" />
        )}
      </div>
      {permission ? (
        <p className="text-[12px] text-[color:var(--muted)] leading-[1.35]">
          {decisionCopy(props.channel, permission.decision.reason)}
        </p>
      ) : null}
    </li>
  );
}

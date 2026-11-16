import { Reveal, Skeleton } from '@knoqra/ui';
import { type FormEvent, useId, useState } from 'react';
import { useMe } from '../../lib/api';
import {
  type MessagingSender,
  type RegistrationStatus,
  useSenders,
  useSetLiveSender,
} from '../../lib/inbox';
import {
  CHANNEL_LABEL,
  type InboxChannel,
  liveSenderErrorCopy,
  liveSenderStatus,
  showLiveSender,
} from '../../lib/inbox-format';
import { focusRing, textPill } from '../../lib/ui-classes';
import { useVoiceConnection } from '../../lib/voice-connection';
import { isOwnerOrAdmin } from '../../lib/wallet-form';

const CHANNELS: readonly InboxChannel[] = ['sms', 'whatsapp'];

export const REGISTRATION_LABEL: Record<RegistrationStatus, string> = {
  not_started: 'Not started',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

const select = `h-[30px] min-w-0 flex-1 cursor-pointer rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 text-[12.5px] text-[color:var(--text)] [box-shadow:var(--pillShadow)] ${focusRing}`;

/**
 * Owners and admins with a saved phone provider connection, on a live deployment: use a number as
 * the live sender of a channel. Both channels' registration status comes from the provider (US
 * texting registration for SMS, Meta's approval for WhatsApp), read by the sync; nobody sets it
 * here. Hidden for everyone else.
 */
export function LiveSenderControl({ channel }: { channel: InboxChannel }) {
  const me = useMe();
  const role = me.data?.organization.role;
  if (!isOwnerOrAdmin(role)) return null;
  return <LiveSenderGate channel={channel} role={role} />;
}

function LiveSenderGate({ channel, role }: { channel: InboxChannel; role: string | undefined }) {
  const connection = useVoiceConnection();
  const senders = useSenders();
  const loading = connection.isPending || senders.isPending;
  const show =
    senders.data !== undefined &&
    showLiveSender({
      role,
      hasConnection: Boolean(connection.data),
      liveAvailable: senders.data.liveAvailable,
    });
  return (
    <Reveal loading={loading}>
      {loading ? (
        <Skeleton width="100%" height={30} label="Loading live sender" />
      ) : show && senders.data ? (
        <LiveSenderForm initialChannel={channel} senders={senders.data.items} />
      ) : null}
    </Reveal>
  );
}

function LiveSenderForm({
  initialChannel,
  senders,
}: {
  initialChannel: InboxChannel;
  senders: readonly MessagingSender[];
}) {
  const save = useSetLiveSender();
  const baseId = useId();
  const [channel, setChannel] = useState<InboxChannel>(initialChannel);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const current = senders.find((s) => s.channel === channel && s.provider === 'telnyx');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    save.mutate(
      { channel },
      {
        onSuccess: () => setMessage({ ok: true, text: 'Live sender saved.' }),
        onError: (error) => setMessage({ ok: false, text: liveSenderErrorCopy(error) }),
      },
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Live sender"
      className="flex flex-col gap-2 border-[color:var(--line)] border-t pt-2"
    >
      <p className="font-semibold text-[12.5px] leading-[1.2]">Live sender</p>
      <div className="flex gap-2">
        <label htmlFor={`${baseId}-channel`} className="sr-only">
          Channel
        </label>
        <select
          id={`${baseId}-channel`}
          value={channel}
          onChange={(e) => setChannel(e.target.value as InboxChannel)}
          className={select}
        >
          {CHANNELS.map((ch) => (
            <option key={ch} value={ch}>
              {CHANNEL_LABEL[ch]}
            </option>
          ))}
        </select>
      </div>
      <p className="text-[12px] text-[color:var(--muted)] leading-[1.35]">
        {current ? `${REGISTRATION_LABEL[current.registrationStatus]}. ` : ''}
        {liveSenderStatus(channel).note}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          aria-busy={save.isPending}
          className={`${textPill} h-[30px] text-[12px]`}
        >
          Use this number
        </button>
        {message ? (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={`text-[12px] leading-[1.35] ${
              message.ok ? 'text-[color:var(--muted)]' : 'text-[color:var(--danger-text)]'
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </form>
  );
}

import { Skeleton } from '@knoqra/ui';
import { MessageCircle, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { type ChannelStatus, useChannels } from '../../lib/inbox';
import { CHANNEL_LABEL } from '../../lib/inbox-format';
import { focusRing } from '../../lib/ui-classes';
import { SmsEnableDialog } from './sms-enable-dialog';
import { WhatsAppEnableDialog } from './whatsapp-enable-dialog';

const STATE_LABEL: Record<ChannelStatus['state'], string> = {
  not_enabled: 'Not enabled',
  pending: 'Pending',
  live: 'Live',
  rejected: 'Needs attention',
};

const STATE_DOT: Record<ChannelStatus['state'], string> = {
  not_enabled: 'var(--dot-none)',
  pending: 'var(--dot-warn)',
  live: 'var(--dot-ok)',
  rejected: 'var(--dot-bad)',
};

/** The button text: Enable while there is something to do, otherwise the status. */
export function channelAction(channel: ChannelStatus): string | null {
  if (!channel.enable.available) return null;
  if (channel.state === 'rejected') return 'Fix';
  if (channel.state === 'pending') return 'Details';
  return 'Enable';
}

/**
 * SMS and WhatsApp at the top of the Inbox: Not enabled, Pending or Live, with Enable for owners
 * and admins. Each opens its dialog (US texting registration, or connecting a WhatsApp number).
 */
export function ChannelsBar() {
  const channels = useChannels();
  const [open, setOpen] = useState<'sms' | 'whatsapp' | null>(null);
  if (channels.isPending) return <Skeleton width="100%" height={36} label="Loading channels" />;
  if (!channels.data) return null;
  const { sms, whatsapp } = channels.data;
  return (
    <section aria-label="Channels" className="flex flex-col gap-1.5 px-2">
      {[sms, whatsapp].map((channel) => {
        const Icon = channel.channel === 'whatsapp' ? MessageCircle : MessageSquare;
        const action = channelAction(channel);
        const clickable =
          action !== null || channel.state === 'pending' || channel.state === 'rejected';
        const body = (
          <>
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className="font-medium">{CHANNEL_LABEL[channel.channel]}</span>
            <span
              aria-hidden="true"
              className="size-[7px] rounded-full"
              style={{ background: STATE_DOT[channel.state] }}
            />
            <span className="text-[color:var(--muted)]">
              {STATE_LABEL[channel.state]}
              {channel.state === 'live' && channel.displayName ? ` · ${channel.displayName}` : ''}
              {channel.sandbox ? ' · sandbox' : ''}
            </span>
            <span className="flex-1" />
            {action ? (
              <span className="font-medium underline-offset-2 group-hover:underline">{action}</span>
            ) : null}
          </>
        );
        return clickable ? (
          <button
            key={channel.channel}
            type="button"
            title={channel.detail}
            onClick={() => setOpen(channel.channel)}
            className={`group flex h-8 cursor-pointer items-center gap-2 rounded-[12px] px-2 text-left text-[12.5px] hover:bg-[color:var(--cell)] ${focusRing}`}
          >
            {body}
          </button>
        ) : (
          <div
            key={channel.channel}
            title={channel.detail}
            className="flex h-8 items-center gap-2 px-2 text-[12.5px]"
          >
            {body}
          </div>
        );
      })}
      {open === 'sms' ? (
        <SmsEnableDialog open onOpenChange={(next) => setOpen(next ? 'sms' : null)} channel={sms} />
      ) : null}
      {open === 'whatsapp' ? (
        <WhatsAppEnableDialog
          open
          onOpenChange={(next) => setOpen(next ? 'whatsapp' : null)}
          channel={whatsapp}
        />
      ) : null}
    </section>
  );
}

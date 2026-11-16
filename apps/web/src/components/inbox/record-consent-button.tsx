import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { useSetPermission } from '../../lib/contact360-queries';
import { conversationKey, conversationsRoot } from '../../lib/inbox';
import { CHANNEL_LABEL, type InboxChannel } from '../../lib/inbox-format';
import { DialogCancel, DialogShell } from '../dialog-shell';

export interface RecordConsentButtonProps {
  conversationId: string;
  contactId: string;
  contactName: string;
  channel: InboxChannel;
}

const EVIDENCE = 'Recorded from inbox';

/** Records that the contact agreed to messages on this channel, after a confirmation. */
export function RecordConsentButton({
  conversationId,
  contactId,
  contactName,
  channel,
}: RecordConsentButtonProps) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const label = CHANNEL_LABEL[channel];
  return (
    <>
      <Button ref={opener} variant="primary" onClick={() => setOpen(true)}>
        <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" />
        {`Record ${label} consent`}
      </Button>
      <DialogShell
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title={`Record that ${contactName} agreed to receive ${label}?`}
        description={`Only record consent they actually gave you. It is saved in their history with the note "${EVIDENCE}".`}
        returnFocus={() => opener.current}
      >
        {open ? (
          <ConfirmConsent
            conversationId={conversationId}
            contactId={contactId}
            channel={channel}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogShell>
    </>
  );
}

function ConfirmConsent(props: {
  conversationId: string;
  contactId: string;
  channel: InboxChannel;
  onDone: () => void;
}) {
  const set = useSetPermission(props.contactId);
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);

  async function confirm() {
    if (set.isPending) return;
    setFailed(false);
    try {
      await set.mutateAsync({ channel: props.channel, status: 'granted', evidence: EVIDENCE });
      // The composer's mode comes from the conversation, so it must be read again.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationKey(props.conversationId) }),
        queryClient.invalidateQueries({ queryKey: conversationsRoot }),
      ]);
      props.onDone();
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      {failed ? (
        <p role="alert" className="mb-3 text-[13px] text-[color:var(--danger-text)]">
          We could not record consent. Nothing was saved. Try again.
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <DialogCancel />
        <Button
          variant="primary"
          disabled={set.isPending}
          aria-busy={set.isPending}
          onClick={() => void confirm()}
        >
          Record consent
        </Button>
      </div>
    </>
  );
}

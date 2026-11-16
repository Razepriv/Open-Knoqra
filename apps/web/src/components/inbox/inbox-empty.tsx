import { Button, Panel } from '@knoqra/ui';
import { useSetSandbox } from '../../lib/inbox';

/** Shown in place of the list when the workspace has no sender yet. */
export function NoSenders({ sandboxAvailable }: { sandboxAvailable: boolean }) {
  const setSandbox = useSetSandbox();
  if (!sandboxAvailable) {
    return (
      <p className="p-2 text-[15px] leading-relaxed">
        Connect a number in Numbers to start messaging.
      </p>
    );
  }
  return (
    <Panel className="flex flex-col items-start gap-3 p-4">
      <p className="font-medium text-[15px]">No sender connected yet.</p>
      <p className="text-[13px] text-[color:var(--muted)]">
        The sandbox sender lets you try SMS and WhatsApp without a carrier.
      </p>
      <Button
        variant="primary"
        onClick={
          setSandbox.isPending
            ? undefined
            : () => setSandbox.mutate({ sms: 'approved', whatsapp: 'approved' })
        }
        aria-busy={setSandbox.isPending}
      >
        Use the sandbox sender
      </Button>
      {setSandbox.isError ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
          We could not set up the sandbox sender. Try again.
        </p>
      ) : null}
    </Panel>
  );
}

export function NoThreads({ q, filtered }: { q: string; filtered: boolean }) {
  if (q) {
    return (
      <p className="p-2 text-[14px] text-[color:var(--muted)]">{`No conversations match "${q}".`}</p>
    );
  }
  if (filtered) {
    return <p className="p-2 text-[14px] text-[color:var(--muted)]">Nothing here right now.</p>;
  }
  return (
    <p className="max-w-[40ch] p-2 text-[15px] leading-relaxed">
      No conversations yet. Start one with New message.
    </p>
  );
}

export function InboxLoadError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-2">
      <p className="font-medium text-[15px]">We could not load your conversations.</p>
      <p className="text-[13px] text-[color:var(--muted)]">Your messages are safe. Try again.</p>
      <Button variant="primary" onClick={retrying ? undefined : onRetry} aria-busy={retrying}>
        Try again
      </Button>
    </div>
  );
}

import { Button } from '@knoqra/ui';
import { deskSlot } from '../../extensions';
import { type ChannelStatus, useRefreshChannels } from '../../lib/inbox';
import { DialogShell } from '../dialog-shell';
import { FormAlert } from '../form-alert';

export interface WhatsAppEnableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: ChannelStatus;
}

/** The bring-your-own path: connect the number at the provider, then KNOQRA finds it. */
function OwnNumberSteps({ onCheck, checking }: { onCheck: () => void; checking: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px]">
        <li>
          In your phone provider's portal, connect a WhatsApp Business number to the account you use
          here.
        </li>
        <li>
          Come back and press Check again. KNOQRA finds the number and shows it as verified once
          Meta approves it.
        </li>
      </ol>
      <div className="flex justify-end">
        <Button type="button" variant="primary" disabled={checking} onClick={onCheck}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Enable WhatsApp. KNOQRA Cloud adds its own signup (DeskExtension `WhatsAppSignup`); everywhere
 * else, and as Cloud's fallback, the number is connected at the provider and found by a sync.
 */
export function WhatsAppEnableDialog({ open, onOpenChange, channel }: WhatsAppEnableDialogProps) {
  const refresh = useRefreshChannels();
  const Signup = deskSlot('WhatsAppSignup');
  const onCheck = () => refresh.mutate();
  const steps = <OwnNumberSteps onCheck={onCheck} checking={refresh.isPending} />;
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Enable WhatsApp"
      description={channel.detail}
    >
      <div className="flex flex-col gap-4">
        <FormAlert
          message={refresh.isError ? 'Could not check right now. Try again in a moment.' : null}
        />
        {Signup ? (
          <Signup fallback={steps} onCheck={onCheck} checking={refresh.isPending} />
        ) : (
          steps
        )}
      </div>
    </DialogShell>
  );
}

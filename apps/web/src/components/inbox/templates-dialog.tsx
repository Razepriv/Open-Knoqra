import { Reveal, StatusDot } from '@knoqra/ui';
import { useState } from 'react';
import { useMe } from '../../lib/api';
import {
  type MessageTemplate,
  useApproveTemplate,
  useArchiveTemplate,
  useTemplates,
} from '../../lib/inbox';
import { CHANNEL_LABEL, canMarkApproved, type InboxChannel } from '../../lib/inbox-format';
import { textPill } from '../../lib/ui-classes';
import { isOwnerOrAdmin } from '../../lib/wallet-form';
import { DialogShell } from '../dialog-shell';
import { TemplateRowsSkeleton } from './inbox-skeletons';
import { TemplateForm } from './template-form';

export interface TemplatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

const CHANNELS: readonly InboxChannel[] = ['sms', 'whatsapp'];

const APPROVAL: Record<
  MessageTemplate['approvalStatus'],
  { tone: 'ok' | 'warn' | 'bad'; label: string }
> = {
  approved: { tone: 'ok', label: 'Approved' },
  pending: { tone: 'warn', label: 'Pending' },
  rejected: { tone: 'bad', label: 'Rejected' },
};

/** Every template by channel, with its approval state; create new ones and archive old ones. */
export function TemplatesDialog({ open, onOpenChange, returnFocus }: TemplatesDialogProps) {
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Templates"
      description="Saved messages for SMS and WhatsApp. WhatsApp only allows approved templates outside the 24 hour window."
      {...(returnFocus ? { returnFocus } : {})}
    >
      {open ? <TemplatesBody /> : null}
    </DialogShell>
  );
}

function TemplatesBody() {
  const templates = useTemplates();
  const manager = isOwnerOrAdmin(useMe().data?.organization.role);
  const items = templates.data?.items ?? [];
  return (
    <div className="flex flex-col gap-6">
      <Reveal loading={templates.isPending}>
        {templates.isPending ? (
          <TemplateRowsSkeleton />
        ) : templates.isError && items.length === 0 ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-[14px] text-[color:var(--danger-text)]">
              We could not load templates.
            </p>
            <button type="button" className={textPill} onClick={() => void templates.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {CHANNELS.map((channel) => (
              <ChannelTemplates
                key={channel}
                channel={channel}
                templates={items.filter((template) => template.channel === channel)}
                manager={manager}
              />
            ))}
          </div>
        )}
      </Reveal>
      <TemplateForm />
    </div>
  );
}

function ChannelTemplates({
  channel,
  templates,
  manager,
}: {
  channel: InboxChannel;
  templates: readonly MessageTemplate[];
  manager: boolean;
}) {
  const label = CHANNEL_LABEL[channel];
  return (
    <section aria-label={`${label} templates`} className="flex flex-col gap-2">
      <h3 className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]">
        {`${label} templates`}
      </h3>
      {templates.length === 0 ? (
        <p className="text-[13px] text-[color:var(--muted)]">{`No ${label} templates yet.`}</p>
      ) : (
        <ul className="flex flex-col gap-[6px]">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} manager={manager} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TemplateRow({ template, manager }: { template: MessageTemplate; manager: boolean }) {
  const archive = useArchiveTemplate();
  const approve = useApproveTemplate();
  const [failed, setFailed] = useState<'archive' | 'approve' | null>(null);
  const approval = APPROVAL[template.approvalStatus];
  return (
    <li className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold text-[13px]">{template.name}</span>
        <StatusDot status={approval.tone} label={approval.label} className="text-[12px]" />
        {manager && canMarkApproved(template) ? (
          <button
            type="button"
            aria-label={`Mark ${template.name} approved in Meta`}
            disabled={approve.isPending}
            aria-busy={approve.isPending}
            onClick={() => {
              setFailed(null);
              approve.mutate(template.id, { onError: () => setFailed('approve') });
            }}
            className={`${textPill} h-[30px] text-[12px]`}
          >
            Mark approved in Meta
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Archive ${template.name}`}
          disabled={archive.isPending}
          aria-busy={archive.isPending}
          onClick={() => {
            setFailed(null);
            archive.mutate(template.id, { onError: () => setFailed('archive') });
          }}
          className={`${textPill} h-[30px] text-[12px]`}
        >
          Archive
        </button>
      </div>
      <p className="whitespace-pre-wrap break-words text-[12.5px] text-[color:var(--muted)] leading-[1.4]">
        {template.body}
      </p>
      {failed ? (
        <p role="alert" className="text-[12.5px] text-[color:var(--danger-text)]">
          {failed === 'archive'
            ? 'We could not archive this template. Try again.'
            : 'We could not mark this template approved. Try again.'}
        </p>
      ) : null}
    </li>
  );
}

import { Button, Reveal } from '@knoqra/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FileText, Send } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  type ConversationDetail,
  type MessageTemplate,
  sendErrorCopy,
  useSendMessage,
  useTemplates,
} from '../../lib/inbox';
import { CHANNEL_LABEL } from '../../lib/inbox-format';
import { menuItem, menuSurface, textPill } from '../../lib/ui-classes';
import { TemplateRowsSkeleton } from './inbox-skeletons';
import { TemplatePicker } from './template-picker';

const MAX_BODY = 1600;

/** Server refusals that mean the composer's mode is out of date. */
const STALE_MODE_CODES = new Set(['send_blocked', 'send_paused', 'template_required']);

export interface SendFailure {
  message: string;
  /** True when the conversation should be read again, since its mode changed under us. */
  stale: boolean;
}

export function sendFailure(error: unknown): SendFailure {
  const stale = error instanceof ApiError && error.status === 422;
  return {
    message: sendErrorCopy(error),
    stale: stale && STALE_MODE_CODES.has(error.code ?? ''),
  };
}

/** Ctrl+Enter (or ⌘+Enter) submits the form the textarea belongs to. */
export function submitOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

export interface ReplyProps {
  conversation: ConversationDetail;
  onFailure: (failure: SendFailure | null) => void;
}

function useApproved(channel: ConversationDetail['channel']) {
  const templates = useTemplates(channel);
  const approved: MessageTemplate[] =
    templates.data?.items.filter(
      (template) => template.approvalStatus === 'approved' && template.archivedAt === null,
    ) ?? [];
  return { templates, approved };
}

/** Free text inside the window (or any time on SMS), with approved templates one click away. */
export function FreeReply({ conversation, onFailure }: ReplyProps) {
  const send = useSendMessage(conversation.id);
  const { approved } = useApproved(conversation.channel);
  const [body, setBody] = useState('');
  const channel = CHANNEL_LABEL[conversation.channel];
  const empty = body.trim() === '';

  function deliver(input: { body?: string; templateId?: string }) {
    if (send.isPending) return;
    onFailure(null);
    send.mutate(input, {
      onSuccess: () => {
        if (input.body !== undefined) setBody('');
      },
      onError: (error) => onFailure(sendFailure(error)),
    });
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) deliver({ body });
      }}
      className="flex flex-col gap-2 rounded-[22px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] py-[10px] pr-3 pl-[14px] [box-shadow:var(--pillShadow)] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2"
    >
      <textarea
        aria-label="Message"
        rows={2}
        maxLength={MAX_BODY}
        placeholder={`Reply on ${channel}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={submitOnModEnter}
        className="min-h-[52px] resize-none bg-transparent text-[14px] text-[color:var(--text)] leading-[1.5] outline-none placeholder:text-[color:var(--muted)]"
      />
      <div className="flex flex-wrap items-center gap-2">
        {conversation.channel === 'sms' ? (
          <span className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)]">
            {`${body.length}/${MAX_BODY}`}
          </span>
        ) : null}
        <span className="hidden font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] sm:inline">
          CTRL + ENTER TO SEND
        </span>
        <span className="flex-1" />
        {approved.length > 0 ? (
          <TemplateMenu
            templates={approved}
            disabled={send.isPending}
            onPick={(templateId) => deliver({ templateId })}
          />
        ) : null}
        <Button
          type="submit"
          variant="primary"
          className="h-9 px-4"
          disabled={empty || send.isPending}
          aria-busy={send.isPending}
        >
          <Send size={14} strokeWidth={2} aria-hidden="true" />
          Send
        </Button>
      </div>
    </form>
  );
}

function TemplateMenu(props: {
  templates: readonly MessageTemplate[];
  disabled: boolean;
  onPick: (templateId: string) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger disabled={props.disabled} className={textPill}>
        <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
        Send a template
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align="end" side="top" sideOffset={6} className={menuSurface}>
          {props.templates.map((template) => (
            <Menu.Item
              key={template.id}
              onSelect={() => props.onPick(template.id)}
              className={menuItem}
            >
              {template.name}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export interface TemplateReplyProps extends ReplyProps {
  onManageTemplates: (returnFocus: () => HTMLElement | null) => void;
}

/** Outside the WhatsApp window: pick an approved template and send it. */
export function TemplateReply({ conversation, onFailure, onManageTemplates }: TemplateReplyProps) {
  const send = useSendMessage(conversation.id);
  const { templates, approved } = useApproved(conversation.channel);
  const [picked, setPicked] = useState<string | null>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const selected = approved.find((template) => template.id === picked)?.id ?? null;

  if (templates.isPending) {
    return (
      <Reveal loading>
        <TemplateRowsSkeleton />
      </Reveal>
    );
  }
  if (templates.isError && approved.length === 0) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-[color:var(--danger-text)]">We could not load templates.</p>
        <button type="button" className={textPill} onClick={() => void templates.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (approved.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-[14px]">
          {`No approved ${CHANNEL_LABEL[conversation.channel]} templates yet.`}
        </p>
        <button
          ref={manageButton}
          type="button"
          className={textPill}
          onClick={() => onManageTemplates(() => manageButton.current)}
        >
          Manage templates
        </button>
      </div>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || send.isPending) return;
        onFailure(null);
        send.mutate(
          { templateId: selected },
          { onError: (error) => onFailure(sendFailure(error)) },
        );
      }}
      className="flex flex-col gap-3"
    >
      <TemplatePicker
        templates={approved}
        contact={conversation.contact}
        value={selected}
        onChange={setPicked}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={!selected || send.isPending}
          aria-busy={send.isPending}
        >
          <Send size={14} strokeWidth={2} aria-hidden="true" />
          Send template
        </Button>
      </div>
    </form>
  );
}

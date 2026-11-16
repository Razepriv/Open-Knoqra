import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Ban, Clock, FileText, type LucideIcon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { type ConversationDetail, conversationKey } from '../../lib/inbox';
import { composerCopy, composerLink } from '../../lib/inbox-format';
import { focusRing, textPill } from '../../lib/ui-classes';
import { FreeReply, type SendFailure, TemplateReply } from './composer-reply';
import { NoteForm } from './note-form';
import { RecordConsentButton } from './record-consent-button';

type Tab = 'reply' | 'note';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'reply', label: 'Reply' },
  { value: 'note', label: 'Internal note' },
];

export interface ComposerProps {
  conversation: ConversationDetail;
  onManageTemplates: (returnFocus: () => HTMLElement | null) => void;
}

/** Reply (shaped by what the server allows right now) or an internal note, which never sends. */
export function Composer({ conversation, onManageTemplates }: ComposerProps) {
  const [tab, setTab] = useState<Tab>('reply');
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const queryClient = useQueryClient();
  const baseId = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ reply: null, note: null });

  function onFailure(next: SendFailure | null) {
    setFailure(next);
    if (next?.stale) {
      void queryClient.invalidateQueries({ queryKey: conversationKey(conversation.id) });
    }
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: Tab =
      event.key === 'Home'
        ? 'reply'
        : event.key === 'End'
          ? 'note'
          : tab === 'reply'
            ? 'note'
            : 'reply';
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-2 px-[14px] pb-[14px]">
      <div role="tablist" aria-label="Composer" className="flex gap-[6px] px-1">
        {TABS.map(({ value, label }) => (
          <button
            key={value}
            ref={(node) => {
              tabRefs.current[value] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-${value}-tab`}
            aria-selected={tab === value}
            aria-controls={`${baseId}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={onTabKey}
            className={`h-8 cursor-pointer rounded-full border border-[color:var(--pillBorder)] px-3 font-medium text-[12.5px] leading-none ${focusRing} ${
              tab === value
                ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
                : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${tab}-panel`}
        aria-labelledby={`${baseId}-${tab}-tab`}
        className="flex flex-col gap-2"
      >
        {tab === 'reply' ? (
          <>
            {failure ? (
              <p role="alert" className="px-1 text-[13px] text-[color:var(--danger-text)]">
                {failure.message}
              </p>
            ) : null}
            <ReplyPanel
              conversation={conversation}
              onFailure={onFailure}
              onManageTemplates={onManageTemplates}
            />
          </>
        ) : (
          <NoteForm conversationId={conversation.id} />
        )}
      </div>
    </div>
  );
}

function ReplyPanel(props: {
  conversation: ConversationDetail;
  onFailure: (failure: SendFailure | null) => void;
  onManageTemplates: (returnFocus: () => HTMLElement | null) => void;
}) {
  const { conversation } = props;
  const { composer, channel, contact } = conversation;
  const copy = composerCopy(channel, composer);
  switch (composer.mode) {
    case 'free':
      return <FreeReply conversation={conversation} onFailure={props.onFailure} />;
    case 'template_only':
      return (
        <StateCard tone="template" icon={FileText} title={copy.title} body={copy.body}>
          <TemplateReply
            conversation={conversation}
            onFailure={props.onFailure}
            onManageTemplates={props.onManageTemplates}
          />
        </StateCard>
      );
    case 'paused': {
      const link = composerLink(composer);
      return (
        <StateCard tone="paused" icon={Clock} title={copy.title} body={copy.body}>
          {link ? (
            <div>
              <Link to={link.to} hash={link.hash} className={textPill}>
                {link.label}
              </Link>
            </div>
          ) : null}
        </StateCard>
      );
    }
    case 'blocked':
      return (
        <StateCard tone="blocked" icon={Ban} title={copy.title} body={copy.body}>
          {composer.reason === 'consent_required' ? (
            <div>
              <RecordConsentButton
                conversationId={conversation.id}
                contactId={contact.id}
                contactName={contact.displayName}
                channel={channel}
              />
            </div>
          ) : null}
        </StateCard>
      );
  }
}

const CARD: Record<'template' | 'paused' | 'blocked', { className: string; icon: string }> = {
  template: {
    className:
      'border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]',
    icon: 'var(--muted)',
  },
  paused: {
    className: 'border-[color:var(--paused-border)] [background:var(--paused-stripe)]',
    icon: 'var(--dot-warn)',
  },
  blocked: {
    className: 'border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]',
    icon: 'var(--dot-bad)',
  },
};

function StateCard(props: {
  tone: keyof typeof CARD;
  icon: LucideIcon;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  const card = CARD[props.tone];
  return (
    <div className={`flex flex-col gap-3 rounded-[22px] border px-4 py-[14px] ${card.className}`}>
      <div role="status" className="flex items-start gap-3">
        <Icon
          size={18}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-[1px] shrink-0"
          style={{ color: card.icon }}
        />
        <div className="flex flex-1 flex-col gap-1">
          <p className="font-semibold text-[14px] leading-[1.3]">{props.title}</p>
          <p className="text-[12.5px] text-[color:var(--muted)] leading-[1.4]">{props.body}</p>
        </div>
      </div>
      {props.children}
    </div>
  );
}

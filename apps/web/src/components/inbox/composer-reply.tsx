import { classifyUpload, MEDIA_LIMITS } from '@knoqra/core';
import { Button, Reveal } from '@knoqra/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ChevronDown,
  CornerUpLeft,
  FileText,
  Mic,
  Paperclip,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import {
  type Attachment,
  type ConversationDetail,
  type MessageTemplate,
  sendErrorCopy,
  uploadAttachment,
  useSendMessage,
  useTemplates,
} from '../../lib/inbox';
import {
  ATTACHMENT_WORDS,
  CHANNEL_LABEL,
  formatBytes,
  formatDuration,
  quoteText,
} from '../../lib/inbox-format';
import { focusRing, iconPill, menuItem, menuSurface, textPill } from '../../lib/ui-classes';
import {
  finishRecording,
  MAX_RECORDING_MS,
  startVoiceRecording,
  type VoiceRecording,
  waveformBars,
} from '../../lib/voice/recorder';
import { useComposerBridge } from './composer-bridge';
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

/** What WhatsApp accepts from the file picker. */
const ACCEPT = [
  ...new Set([
    ...MEDIA_LIMITS.image.types,
    ...MEDIA_LIMITS.video.types,
    ...MEDIA_LIMITS.audio.types,
    ...MEDIA_LIMITS.document.types,
  ]),
].join(',');

const UPLOAD_REFUSAL: Record<string, string> = {
  empty: 'That file is empty.',
  unsupported_type: "WhatsApp can't send this type of file.",
  too_large:
    'That file is larger than WhatsApp allows (images 5 MB, audio and video 16 MB, documents 100 MB).',
};

type Draft =
  | { state: 'uploading'; name: string; kind: string }
  | { state: 'ready'; attachment: Attachment };

/**
 * Free text inside the window (or any time on SMS), with approved templates one click away. On
 * WhatsApp it also sends files (picker or drop), voice notes and replies. A send shows in the thread
 * at once and the composer clears straight away; delivery is followed in the thread.
 */
export function FreeReply({ conversation, onFailure }: ReplyProps) {
  const send = useSendMessage(conversation.id, conversation.channel);
  const { approved } = useApproved(conversation.channel);
  const bridge = useComposerBridge();
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [recording, setRecording] = useState<VoiceRecording | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const channel = CHANNEL_LABEL[conversation.channel];
  const whatsapp = conversation.channel === 'whatsapp';
  const ready = draft?.state === 'ready' ? draft.attachment : null;
  const empty = body.trim() === '' && !ready;

  function deliver(input: { body?: string; templateId?: string; attachment?: Attachment }) {
    onFailure(null);
    const replyTo = input.templateId ? undefined : (bridge.replyTo ?? undefined);
    send.mutate(
      { clientMessageId: crypto.randomUUID(), ...input, ...(replyTo ? { replyTo } : {}) },
      { onError: (error) => onFailure(sendFailure(error)) },
    );
    if (!input.templateId) {
      setBody('');
      setDraft(null);
      bridge.setReplyTo(null);
    }
  }

  async function attach(file: File) {
    onFailure(null);
    const kind = classifyUpload(file.type, file.size);
    if (!kind.ok) {
      onFailure({
        message: UPLOAD_REFUSAL[kind.error] ?? "WhatsApp can't send this type of file.",
        stale: false,
      });
      return;
    }
    setDraft({ state: 'uploading', name: file.name, kind: kind.value });
    try {
      const attachment = await uploadAttachment(conversation.id, { file, name: file.name });
      setDraft({ state: 'ready', attachment });
    } catch (error) {
      setDraft(null);
      onFailure({
        message: error instanceof ApiError ? error.message : 'Could not upload this file.',
        stale: false,
      });
    }
  }

  // A file dropped anywhere on the thread lands here.
  const { dropped, setDropped } = bridge;
  // biome-ignore lint/correctness/useExhaustiveDependencies: attach is stable enough per render; run once per drop.
  useEffect(() => {
    if (!dropped) return;
    setDropped(null);
    if (whatsapp) void attach(dropped);
    else onFailure({ message: 'Files can be sent on WhatsApp only.', stale: false });
  }, [dropped]);

  async function record() {
    onFailure(null);
    try {
      setRecording(await startVoiceRecording());
    } catch (error) {
      onFailure({
        message:
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Allow the microphone to record a voice message.'
            : error instanceof Error
              ? error.message
              : 'Could not start recording.',
        stale: false,
      });
    }
  }

  async function finishVoice(keep: boolean) {
    const current = recording;
    if (!current) return;
    if (!keep) {
      current.cancel();
      setRecording(null);
      return;
    }
    const levels = current.levels();
    const durationMs = current.elapsedMs();
    const blob = await current.stop();
    setRecording(null);
    setDraft({ state: 'uploading', name: 'Voice message', kind: 'voice' });
    try {
      const file = await finishRecording(blob, current.format);
      const attachment = await uploadAttachment(conversation.id, {
        file: file.file,
        name: file.name,
        voice: file.voice,
        durationMs,
        waveform: waveformBars(levels),
      });
      setDraft(null);
      // A voice note goes as soon as it is recorded, as in WhatsApp.
      deliver({ attachment });
    } catch (error) {
      setDraft(null);
      onFailure({
        message: error instanceof Error ? error.message : 'Could not send the voice message.',
        stale: false,
      });
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (empty || draft?.state === 'uploading') return;
        deliver({ ...(body.trim() ? { body } : {}), ...(ready ? { attachment: ready } : {}) });
      }}
      className="flex flex-col gap-2 rounded-[22px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] py-[10px] pr-3 pl-[14px] [box-shadow:var(--pillShadow)] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2"
    >
      {bridge.replyTo ? (
        <div className="flex items-start gap-2 rounded-[14px] border-[color:var(--line)] border-l-[3px] bg-[color:var(--cell)] px-3 py-2">
          <CornerUpLeft
            size={14}
            strokeWidth={1.75}
            aria-hidden="true"
            className="mt-[2px] shrink-0"
          />
          <p className="min-w-0 flex-1 truncate text-[12.5px]">
            <span className="font-semibold">Replying to </span>
            {quoteText({
              body: bridge.replyTo.body,
              attachmentKind: bridge.replyTo.attachments[0]?.kind ?? null,
            })}
          </p>
          <button
            type="button"
            onClick={() => bridge.setReplyTo(null)}
            aria-label="Cancel reply"
            className={`${iconPill} size-6`}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {draft ? (
        <div className="flex items-center gap-2 rounded-[14px] bg-[color:var(--cell)] px-3 py-2 text-[12.5px]">
          <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {draft.state === 'uploading'
              ? `Uploading ${draft.name}…`
              : `${ATTACHMENT_WORDS[draft.attachment.kind] ?? 'File'}: ${draft.attachment.fileName ?? ''}${
                  draft.attachment.sizeBytes ? ` · ${formatBytes(draft.attachment.sizeBytes)}` : ''
                }`}
          </span>
          {draft.state === 'ready' ? (
            <button
              type="button"
              onClick={() => setDraft(null)}
              aria-label="Remove file"
              className={`${iconPill} size-6`}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {recording ? (
        <RecordingBar
          recording={recording}
          onStop={() => void finishVoice(true)}
          onCancel={() => void finishVoice(false)}
        />
      ) : (
        <textarea
          aria-label="Message"
          rows={2}
          maxLength={MAX_BODY}
          placeholder={ready ? 'Add a caption' : `Reply on ${channel}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={submitOnModEnter}
          onPaste={(event) => {
            const file = event.clipboardData.files[0];
            if (file && whatsapp) {
              event.preventDefault();
              void attach(file);
            }
          }}
          className="min-h-[52px] resize-none bg-transparent text-[14px] text-[color:var(--text)] leading-[1.5] outline-none placeholder:text-[color:var(--muted)]"
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {whatsapp && !recording ? (
          <>
            <input
              ref={picker}
              type="file"
              accept={ACCEPT}
              className="hidden"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void attach(file);
              }}
            />
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={draft !== null}
              aria-label="Attach a file"
              className={`${iconPill} size-9 disabled:opacity-50`}
            >
              <Paperclip size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        ) : null}
        {conversation.channel === 'sms' ? (
          <span className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)]">
            {`${body.length}/${MAX_BODY}`}
          </span>
        ) : null}
        <span className="hidden font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] sm:inline">
          CTRL + ENTER TO SEND
        </span>
        <span className="flex-1" />
        {approved.length > 0 && !recording ? (
          <TemplateMenu
            templates={approved}
            disabled={false}
            onPick={(templateId) => deliver({ templateId })}
          />
        ) : null}
        {whatsapp && empty && !draft && !recording ? (
          <Button
            type="button"
            variant="primary"
            className="h-9 px-4"
            onClick={() => void record()}
            aria-label="Record a voice message"
          >
            <Mic size={14} strokeWidth={2} aria-hidden="true" />
            Record
          </Button>
        ) : recording ? null : (
          <Button
            type="submit"
            variant="primary"
            className="h-9 px-4"
            disabled={empty || draft?.state === 'uploading'}
          >
            <Send size={14} strokeWidth={2} aria-hidden="true" />
            Send
          </Button>
        )}
      </div>
    </form>
  );
}

/** While recording: a live level meter, the time, Cancel and Send. */
function RecordingBar({
  recording,
  onStop,
  onCancel,
}: {
  recording: VoiceRecording;
  onStop: () => void;
  onCancel: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      tick((n) => n + 1);
      if (recording.elapsedMs() >= MAX_RECORDING_MS) onStop();
    }, 200);
    return () => clearInterval(id);
  }, [recording, onStop]);
  const bars = waveformBars(recording.levels().slice(-48), 48);
  return (
    <div
      role="status"
      className="flex min-h-[52px] items-center gap-3"
      aria-label="Recording a voice message"
    >
      <span
        aria-hidden="true"
        className="size-[9px] shrink-0 animate-pulse rounded-full"
        style={{ background: 'var(--dot-bad)' }}
      />
      <span className="font-[family-name:var(--font-mono)] text-[12px] tabular-nums">
        {formatDuration(recording.elapsedMs() / 1000)}
      </span>
      <span className="flex h-7 flex-1 items-center gap-[2px]" aria-hidden="true">
        {bars.map((bar, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed run of bars.
            key={i}
            className="w-[3px] flex-1 rounded-full bg-[color:var(--muted)]"
            style={{ height: `${Math.max(10, bar)}%` }}
          />
        ))}
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Discard recording"
        className={`${iconPill} size-9 ${focusRing}`}
      >
        <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <Button
        type="button"
        variant="primary"
        className="h-9 px-4"
        onClick={onStop}
        aria-label="Send voice message"
      >
        <Square size={12} strokeWidth={2.5} aria-hidden="true" />
        Send
      </Button>
    </div>
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
  const send = useSendMessage(conversation.id, conversation.channel);
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
          { clientMessageId: crypto.randomUUID(), templateId: selected },
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

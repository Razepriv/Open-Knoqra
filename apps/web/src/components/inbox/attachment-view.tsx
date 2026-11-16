import * as Dialog from '@radix-ui/react-dialog';
import { Download, FileText, ImageOff, Pause, Play, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { Attachment } from '../../lib/inbox';
import { formatBytes, formatDuration } from '../../lib/inbox-format';
import { dialogOverlay, focusRing, iconPill } from '../../lib/ui-classes';

/**
 * The attachment's link, refreshed when it has expired or failed to load (links are signed and
 * short-lived). Null while there is nothing to fetch.
 */
function useAttachmentUrl(attachment: Attachment): { url: string | null; onError: () => void } {
  const [fresh, setFresh] = useState<{ url: string | null; expiresAt: string | null } | null>(null);
  const tried = useRef(false);
  const url = fresh?.url ?? attachment.url;
  const expiresAt = fresh?.expiresAt ?? attachment.urlExpiresAt;
  const refresh = useCallback(async () => {
    if (tried.current) return;
    tried.current = true;
    const result = await api.GET('/api/v1/attachments/{id}', {
      params: { path: { id: attachment.id } },
    });
    if (result.data?.data)
      setFresh({ url: result.data.data.url, expiresAt: result.data.data.urlExpiresAt });
  }, [attachment.id]);
  useEffect(() => {
    if (url && expiresAt && new Date(expiresAt).getTime() < Date.now() + 60_000) void refresh();
  }, [url, expiresAt, refresh]);
  // A new copy of the attachment from the server (stored after download) resets the retry.
  const serverUrl = attachment.url;
  useEffect(() => {
    void serverUrl;
    tried.current = false;
    setFresh(null);
  }, [serverUrl]);
  return { url, onError: () => void refresh() };
}

const frame =
  'overflow-hidden rounded-[14px] border border-[color:var(--pillBorder)] bg-[color:var(--cell)]';

function Unavailable({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[12.5px] opacity-80">
      <ImageOff size={14} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </p>
  );
}

function ImageAttachment({ attachment, sticker }: { attachment: Attachment; sticker: boolean }) {
  const { url, onError } = useAttachmentUrl(attachment);
  const [open, setOpen] = useState(false);
  if (attachment.status === 'failed')
    return <Unavailable label="This photo is no longer available." />;
  if (!url)
    return (
      <div
        className={`${frame} h-[180px] w-[220px] animate-pulse`}
        role="status"
        aria-label="Loading photo"
      />
    );
  const label = sticker ? 'Sticker' : 'Photo';
  if (sticker) {
    return (
      <img
        src={url}
        alt={label}
        onError={onError}
        className="size-[128px] object-contain"
        loading="lazy"
      />
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${frame} block cursor-zoom-in p-0 ${focusRing}`}
        aria-label="Open photo"
      >
        <img
          src={url}
          alt={label}
          onError={onError}
          loading="lazy"
          className="max-h-[280px] max-w-[min(320px,100%)] object-cover"
        />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlay} />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 outline-none"
            onClick={() => setOpen(false)}
          >
            <Dialog.Title className="sr-only">Photo</Dialog.Title>
            <img
              src={url}
              alt={label}
              className="max-h-full max-w-full rounded-[18px] object-contain [box-shadow:var(--shadow-tile)]"
            />
            <div className="absolute top-4 right-4 flex gap-2">
              <a
                href={url}
                download={attachment.fileName ?? 'photo'}
                onClick={(e) => e.stopPropagation()}
                className={`${iconPill} size-10`}
                aria-label="Download photo"
              >
                <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              </a>
              <Dialog.Close className={`${iconPill} size-10`} aria-label="Close">
                <X size={16} strokeWidth={1.75} aria-hidden="true" />
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const { url, onError } = useAttachmentUrl(attachment);
  if (attachment.status === 'failed')
    return <Unavailable label="This video is no longer available." />;
  if (!url)
    return (
      <div
        className={`${frame} h-[180px] w-[260px] animate-pulse`}
        role="status"
        aria-label="Loading video"
      />
    );
  return (
    // biome-ignore lint/a11y/useMediaCaption: the contact's own video has no captions to offer.
    <video
      src={url}
      controls
      preload="metadata"
      onError={onError}
      className={`${frame} max-h-[300px] max-w-[min(320px,100%)]`}
    />
  );
}

function DocumentAttachment({ attachment }: { attachment: Attachment }) {
  const { url } = useAttachmentUrl(attachment);
  const name = attachment.fileName ?? 'Document';
  const size = attachment.sizeBytes !== null ? formatBytes(attachment.sizeBytes) : null;
  return (
    <div className="flex min-w-[220px] items-center gap-3 rounded-[14px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 py-2.5 text-[color:var(--text)]">
      <FileText size={22} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-[13px]">{name}</span>
        <span className="text-[11.5px] text-[color:var(--muted)]">
          {attachment.status === 'failed' ? 'No longer available' : (size ?? 'File')}
        </span>
      </div>
      {url && attachment.status !== 'failed' ? (
        <a
          href={url}
          download={name}
          className={`${iconPill} size-8`}
          aria-label={`Download ${name}`}
        >
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

/** A voice note or audio file: play and pause, a waveform that fills as it plays, and the length. */
export function VoicePlayer({ attachment }: { attachment: Attachment }) {
  const { url, onError } = useAttachmentUrl(attachment);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState((attachment.durationMs ?? 0) / 1000);
  const bars = attachment.waveform ?? null;
  if (attachment.status === 'failed')
    return <Unavailable label="This voice message is no longer available." />;
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = fraction * el.duration;
    setPosition(el.currentTime);
  };
  return (
    <div className="flex min-w-[220px] items-center gap-3">
      <button
        type="button"
        disabled={!url}
        onClick={() => {
          const el = audio.current;
          if (!el) return;
          if (el.paused) void el.play().catch(() => onError());
          else el.pause();
        }}
        aria-label={
          playing ? 'Pause' : attachment.kind === 'voice' ? 'Play voice message' : 'Play audio'
        }
        className={`${iconPill} size-9 disabled:opacity-50`}
      >
        {playing ? (
          <Pause size={15} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Play size={15} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={`flex h-8 flex-1 cursor-pointer items-center gap-[2px] rounded-[6px] bg-transparent p-0 ${focusRing}`}
        aria-label="Seek"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          seek((event.clientX - box.left) / box.width);
        }}
      >
        {bars ? (
          bars.map((bar, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are a fixed sequence.
              key={i}
              className="w-[3px] flex-1 rounded-full"
              style={{
                height: `${Math.max(12, bar)}%`,
                background:
                  i / bars.length <= progress
                    ? 'currentColor'
                    : 'color-mix(in srgb, currentColor 35%, transparent)',
              }}
            />
          ))
        ) : (
          <span
            className="relative h-[4px] w-full rounded-full"
            style={{ background: 'color-mix(in srgb, currentColor 30%, transparent)' }}
          >
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: `${progress * 100}%`, background: 'currentColor' }}
            />
          </span>
        )}
      </button>
      <span className="font-[family-name:var(--font-mono)] text-[11px] tabular-nums opacity-80">
        {formatDuration(playing || position > 0 ? position : duration)}
      </span>
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: a voice message has no captions.
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onError={onError}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          }}
        />
      ) : null}
    </div>
  );
}

/** One file of a message, shown as its kind asks. */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  switch (attachment.kind) {
    case 'image':
      return <ImageAttachment attachment={attachment} sticker={false} />;
    case 'sticker':
      return <ImageAttachment attachment={attachment} sticker />;
    case 'video':
      return <VideoAttachment attachment={attachment} />;
    case 'document':
      return <DocumentAttachment attachment={attachment} />;
    case 'audio':
    case 'voice':
      return <VoicePlayer attachment={attachment} />;
  }
}

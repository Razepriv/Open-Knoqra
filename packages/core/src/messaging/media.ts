import { err, ok, type Result } from '../result';

/**
 * What a message attachment is. `voice` is a recorded voice note (OGG/Opus), shown with a waveform;
 * `audio` is any other audio file. Stickers only arrive: WhatsApp has no way to upload one here.
 */
export const ATTACHMENT_KINDS = [
  'image',
  'audio',
  'voice',
  'video',
  'document',
  'sticker',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_STATUSES = ['pending', 'stored', 'failed'] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

const MB = 1024 * 1024;

/**
 * WhatsApp's media limits (Meta's supported-media table): the types it accepts and the largest file
 * of each kind. Office documents are listed by their MIME types.
 */
export const MEDIA_LIMITS: Record<AttachmentKind, { maxBytes: number; types: readonly string[] }> =
  {
    image: { maxBytes: 5 * MB, types: ['image/jpeg', 'image/png', 'image/webp'] },
    audio: {
      maxBytes: 16 * MB,
      types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
    },
    voice: { maxBytes: 16 * MB, types: ['audio/ogg'] },
    video: { maxBytes: 16 * MB, types: ['video/mp4', 'video/3gpp'] },
    document: {
      maxBytes: 100 * MB,
      types: [
        'application/pdf',
        'text/plain',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ],
    },
    sticker: { maxBytes: 500 * 1024, types: ['image/webp'] },
  };

/** The largest file any kind accepts: an upload above it is refused before it is read. */
export const MAX_ATTACHMENT_BYTES = MEDIA_LIMITS.document.maxBytes;

/** WhatsApp shows a voice note's play button only up to this size. */
export const VOICE_NOTE_PLAY_ICON_BYTES = 512 * 1024;

/** Captions on images, videos and documents: at most 1024 bytes of UTF-8. */
export const MAX_CAPTION_BYTES = 1024;

/** `audio/ogg; codecs=opus` → `audio/ogg`, lower case. */
export function baseMimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** True for `audio/ogg` declared with any codec other than Opus (WhatsApp takes Opus only). */
function isNonOpusOgg(mime: string): boolean {
  const codecs = /codecs\s*=\s*"?([^";]+)"?/i.exec(mime)?.[1]?.toLowerCase();
  return baseMimeType(mime) === 'audio/ogg' && codecs !== undefined && !codecs.includes('opus');
}

export type UploadRefusal = 'empty' | 'unsupported_type' | 'too_large';

/**
 * The kind an outbound upload is sent as, or why WhatsApp would refuse it. `voice` asks for a voice
 * note, which must be OGG/Opus; any other audio is sent as plain audio. Stickers cannot be uploaded.
 */
export function classifyUpload(
  mime: string,
  sizeBytes: number,
  opts: { voice?: boolean } = {},
): Result<Exclude<AttachmentKind, 'sticker'>, UploadRefusal> {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return err('empty');
  const base = baseMimeType(mime);
  if (isNonOpusOgg(mime)) return err('unsupported_type');
  const order: Exclude<AttachmentKind, 'sticker'>[] = opts.voice
    ? ['voice']
    : ['image', 'audio', 'video', 'document'];
  const kind = order.find((k) => MEDIA_LIMITS[k].types.includes(base));
  if (!kind) return err('unsupported_type');
  if (sizeBytes > MEDIA_LIMITS[kind].maxBytes) return err('too_large');
  return ok(kind);
}

/** The words a conversation preview and the timeline use for a message with no text. */
export const ATTACHMENT_LABELS: Record<AttachmentKind, string> = {
  image: 'Photo',
  audio: 'Audio',
  voice: 'Voice message',
  video: 'Video',
  document: 'Document',
  sticker: 'Sticker',
};

/** A conversation preview for a message: its text, else what it carries. */
export function messagePreviewText(body: string, kind: AttachmentKind | null): string {
  const text = body.trim();
  if (text.length > 0) return kind ? `${ATTACHMENT_LABELS[kind]}: ${text}` : text;
  return kind ? ATTACHMENT_LABELS[kind] : '';
}

/** The extension a stored file gets when it has no name of its own. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** A safe download name: the given one stripped of paths and control characters, or a default. */
export function attachmentFileName(
  name: string | null,
  kind: AttachmentKind,
  mime: string,
): string {
  const cleaned = Array.from(name ?? '')
    .filter((char) => {
      const code = char.charCodeAt(0);
      // Control characters, quotes, backslashes and slashes never reach a download name.
      return code > 0x1f && code !== 0x7f && char !== '"' && char !== '\\' && char !== '/';
    })
    .join('')
    .trim()
    .slice(0, 120);
  if (cleaned.length > 0 && cleaned !== '.' && cleaned !== '..') return cleaned;
  const ext = EXTENSIONS[baseMimeType(mime)] ?? 'bin';
  return `${kind}.${ext}`;
}

/** At most this many bars in a stored waveform; each is an integer from 0 to 100. */
export const WAVEFORM_BARS = 48;

/** Parses a stored or uploaded waveform (`"0,12,100,..."`); anything malformed is null. */
export function parseWaveform(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const parts = raw.split(',');
  if (parts.length === 0 || parts.length > WAVEFORM_BARS) return null;
  const bars = parts.map((p) => Number(p));
  if (bars.some((b) => !Number.isInteger(b) || b < 0 || b > 100)) return null;
  return bars;
}

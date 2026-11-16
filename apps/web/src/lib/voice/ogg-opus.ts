/**
 * WebM/Opus → Ogg/Opus, in the browser. WhatsApp plays a voice note only as Ogg with the Opus codec;
 * Chrome's MediaRecorder records Opus inside WebM. The audio frames are the same Opus packets, so
 * this repackages them without re-encoding: it reads the WebM (EBML) container for the track's
 * OpusHead and frames, then writes Ogg pages (RFC 3533) as RFC 7845 lays out Opus in Ogg.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Audio: 0xe1,
  Channels: 0x9f,
  SamplingFrequency: 0xb5,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Master elements whose children are walked in place (a flat walk copes with unknown sizes). */
const MASTERS: ReadonlySet<number> = new Set([
  ID.Segment,
  ID.Tracks,
  ID.TrackEntry,
  ID.Audio,
  ID.Cluster,
  ID.BlockGroup,
]);

export class RemuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemuxError';
  }
}

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/** An EBML variable-length integer at `at`; `keepMarker` for element ids. */
function readVint(bytes: Uint8Array, at: number, keepMarker: boolean): Vint {
  const first = bytes[at];
  if (first === undefined) throw new RemuxError('truncated');
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) throw new RemuxError('bad length');
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i] as number;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(bytes: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + (bytes[start + i] as number);
  return value;
}

function readFloat(bytes: Uint8Array, start: number, size: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, size);
  return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

export interface WebmOpus {
  head: Uint8Array | null;
  channels: number;
  sampleRate: number;
  codecDelayNs: number;
  frames: Uint8Array[];
}

/** Reads the Opus track's header and frames out of a WebM file. */
export function readWebmOpus(bytes: Uint8Array): WebmOpus {
  const out: WebmOpus = {
    head: null,
    channels: 1,
    sampleRate: 48_000,
    codecDelayNs: 0,
    frames: [],
  };
  let codec: string | null = null;
  let track: number | null = null;
  let at = 0;
  while (at < bytes.length) {
    const id = readVint(bytes, at, true);
    const size = readVint(bytes, at + id.length, false);
    const start = at + id.length + size.length;
    if (MASTERS.has(id.value)) {
      at = start; // walk into the children
      continue;
    }
    if (size.unknown) throw new RemuxError('unknown size on a leaf');
    const end = start + size.value;
    if (end > bytes.length) break; // a cut-off last element: keep what came before
    switch (id.value) {
      case ID.TrackNumber:
        track ??= readUint(bytes, start, size.value);
        break;
      case ID.CodecID:
        codec ??= new TextDecoder().decode(bytes.subarray(start, end));
        break;
      case ID.CodecPrivate:
        out.head ??= bytes.slice(start, end);
        break;
      case ID.CodecDelay:
        out.codecDelayNs = readUint(bytes, start, size.value);
        break;
      case ID.Channels:
        out.channels = readUint(bytes, start, size.value);
        break;
      case ID.SamplingFrequency:
        out.sampleRate = Math.round(readFloat(bytes, start, size.value));
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        const trackNo = readVint(bytes, start, false);
        if (track !== null && trackNo.value !== track) break;
        const flags = bytes[start + trackNo.length + 2] as number;
        if (flags & 0x06) throw new RemuxError('laced blocks are not supported');
        out.frames.push(bytes.slice(start + trackNo.length + 3, end));
        break;
      }
      default:
        break;
    }
    at = end;
  }
  if (codec !== null && codec !== 'A_OPUS') throw new RemuxError(`not Opus: ${codec}`);
  if (out.frames.length === 0) throw new RemuxError('no audio');
  return out;
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  let frameSamples: number;
  if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3] as number;
  else if (config < 16) frameSamples = config & 1 ? 960 : 480;
  else frameSamples = [120, 240, 480, 960][config & 3] as number;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frameSamples * frames;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32 (polynomial 0x04C11DB7, no reflection, zero start). */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes)
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0;
  return crc >>> 0;
}

function oggPage(
  packets: Uint8Array[],
  opts: { granule: number; serial: number; sequence: number; first: boolean; last: boolean },
): Uint8Array {
  const segments: number[] = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) {
      segments.push(255);
      left -= 255;
    }
    segments.push(left);
  }
  if (segments.length > 255) throw new RemuxError('page too large');
  const bodyLength = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + segments.length + bodyLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0;
  page[5] = (opts.first ? 0x02 : 0) | (opts.last ? 0x04 : 0);
  view.setUint32(6, opts.granule % 2 ** 32, true);
  view.setUint32(10, Math.floor(opts.granule / 2 ** 32), true);
  view.setUint32(14, opts.serial, true);
  view.setUint32(18, opts.sequence, true);
  page[26] = segments.length;
  page.set(segments, 27);
  let offset = 27 + segments.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** The 19-byte OpusHead for a track that gave none (RFC 7845 §5.1). */
function opusHead(channels: number, preSkip: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, sampleRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('KNOQRA');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return tags;
}

/** At most this many packets per audio page (about a second of 20 ms frames). */
const PACKETS_PER_PAGE = 50;

/** Repackages WebM/Opus bytes as an Ogg/Opus file. Throws RemuxError when it cannot. */
export function webmToOggOpus(webm: Uint8Array, serial = 0x4b4e5152): Uint8Array {
  const track = readWebmOpus(webm);
  const preSkip = Math.round((track.codecDelayNs * 48_000) / 1e9);
  const head =
    track.head && new TextDecoder().decode(track.head.subarray(0, 8)) === 'OpusHead'
      ? track.head
      : opusHead(track.channels, preSkip, track.sampleRate);
  const pages: Uint8Array[] = [
    oggPage([head], { granule: 0, serial, sequence: 0, first: true, last: false }),
    oggPage([opusTags()], { granule: 0, serial, sequence: 1, first: false, last: false }),
  ];
  let granule = 0;
  for (let i = 0, sequence = 2; i < track.frames.length; i += PACKETS_PER_PAGE, sequence++) {
    const packets = track.frames.slice(i, i + PACKETS_PER_PAGE);
    for (const packet of packets) granule += opusPacketSamples(packet);
    pages.push(
      oggPage(packets, {
        granule,
        serial,
        sequence,
        first: false,
        last: i + PACKETS_PER_PAGE >= track.frames.length,
      }),
    );
  }
  const total = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }
  return out;
}

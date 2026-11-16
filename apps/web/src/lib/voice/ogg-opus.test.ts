import { describe, expect, it } from 'vitest';
import { oggCrc, opusPacketSamples, RemuxError, readWebmOpus, webmToOggOpus } from './ogg-opus';

/** An EBML element: id bytes, a size vint, then the content. `unknown` writes Chrome's unknown size. */
function element(id: number[], content: Uint8Array | number[], unknown = false): Uint8Array {
  const body = content instanceof Uint8Array ? content : new Uint8Array(content);
  const size = unknown
    ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    : body.length < 0x7f
      ? [0x80 | body.length]
      : [0x40 | (body.length >> 8), body.length & 0xff];
  return concat([new Uint8Array(id), new Uint8Array(size), body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

function opusHeadBytes(): Uint8Array {
  const head = new Uint8Array(19);
  head.set(text('OpusHead'));
  head[8] = 1;
  head[9] = 1;
  new DataView(head.buffer).setUint16(10, 312, true);
  new DataView(head.buffer).setUint32(12, 48_000, true);
  return head;
}

/** A 20 ms CELT frame (config 31, one frame): TOC 0xF8 then filler. */
const frame = (n: number) => new Uint8Array([0xf8, n, n, n, n]);

/** What Chrome's MediaRecorder writes for an Opus voice recording, reduced to the parts that matter. */
function chromeLikeWebm(frames: Uint8Array[], withHead = true): Uint8Array {
  const sampling = new Uint8Array(8);
  new DataView(sampling.buffer).setFloat64(0, 48_000);
  const trackEntry = element(
    [0xae],
    concat([
      element([0xd7], [1]),
      element([0x86], text('A_OPUS')),
      ...(withHead ? [element([0x63, 0xa2], opusHeadBytes())] : []),
      element([0xe1], concat([element([0x9f], [1]), element([0xb5], sampling)])),
    ]),
  );
  const blocks = frames.map((f, i) =>
    element([0xa3], concat([new Uint8Array([0x81, 0x00, i * 20, 0x80]), f])),
  );
  const cluster = element(
    [0x1f, 0x43, 0xb6, 0x75],
    concat([element([0xe7], [0]), ...blocks]),
    true,
  );
  const segment = element(
    [0x18, 0x53, 0x80, 0x67],
    concat([element([0x16, 0x54, 0xae, 0x6b], trackEntry), cluster]),
    true,
  );
  return concat([element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], text('webm'))), segment]);
}

interface Page {
  type: number;
  granule: number;
  sequence: number;
  packets: Uint8Array[];
  crcOk: boolean;
}

function readPages(ogg: Uint8Array): Page[] {
  const pages: Page[] = [];
  let at = 0;
  while (at < ogg.length) {
    expect(new TextDecoder().decode(ogg.subarray(at, at + 4))).toBe('OggS');
    const view = new DataView(ogg.buffer, ogg.byteOffset + at);
    const count = ogg[at + 26] as number;
    const segs = Array.from(ogg.subarray(at + 27, at + 27 + count));
    const bodyLength = segs.reduce((n, s) => n + s, 0);
    const size = 27 + count + bodyLength;
    const copy = ogg.slice(at, at + size);
    const stored = view.getUint32(22, true);
    new DataView(copy.buffer).setUint32(22, 0, true);
    const packets: Uint8Array[] = [];
    let offset = at + 27 + count;
    let current: number[] = [];
    for (const s of segs) {
      current.push(...ogg.subarray(offset, offset + s));
      offset += s;
      if (s < 255) {
        packets.push(new Uint8Array(current));
        current = [];
      }
    }
    pages.push({
      type: ogg[at + 5] as number,
      granule: view.getUint32(6, true),
      sequence: view.getUint32(18, true),
      packets,
      crcOk: oggCrc(copy) === stored,
    });
    at += size;
  }
  return pages;
}

describe('webmToOggOpus', () => {
  it('repackages the Opus frames of a Chrome WebM recording as Ogg/Opus', () => {
    const frames = [frame(1), frame(2), frame(3)];
    const pages = readPages(webmToOggOpus(chromeLikeWebm(frames)));
    expect(pages.every((p) => p.crcOk)).toBe(true);
    expect(pages.map((p) => p.sequence)).toEqual([0, 1, 2]);
    expect(pages[0]?.type).toBe(0x02);
    expect(new TextDecoder().decode(pages[0]?.packets[0]?.subarray(0, 8))).toBe('OpusHead');
    expect(new TextDecoder().decode(pages[1]?.packets[0]?.subarray(0, 8))).toBe('OpusTags');
    expect(pages[2]?.packets).toEqual(frames);
    expect(pages[2]?.granule).toBe(3 * 960);
    expect(pages[2]?.type).toBe(0x04);
  });

  it('writes an OpusHead when the track has none, and splits long recordings into pages', () => {
    const frames = Array.from({ length: 120 }, (_, i) => frame(i % 250));
    const pages = readPages(webmToOggOpus(chromeLikeWebm(frames, false)));
    expect(new TextDecoder().decode(pages[0]?.packets[0]?.subarray(0, 8))).toBe('OpusHead');
    expect(pages.length).toBe(2 + 3);
    expect(pages.at(-1)?.granule).toBe(120 * 960);
    expect(pages.slice(2).flatMap((p) => p.packets)).toEqual(frames);
    expect(pages.filter((p) => p.type & 0x04)).toHaveLength(1);
  });

  it('refuses a recording that is not Opus or has no audio', () => {
    const vorbis = chromeLikeWebm([frame(1)]);
    const at = vorbis.indexOf(0x41); // "A" of A_OPUS
    vorbis.set(text('A_VORB'), at);
    expect(() => readWebmOpus(vorbis)).toThrow(RemuxError);
    expect(() => webmToOggOpus(chromeLikeWebm([]))).toThrow(RemuxError);
  });
});

describe('opusPacketSamples', () => {
  it('reads the frame size and count from the TOC byte', () => {
    expect(opusPacketSamples(new Uint8Array([0xf8]))).toBe(960); // CELT 20 ms, one frame
    expect(opusPacketSamples(new Uint8Array([0xf9]))).toBe(1920); // two frames
    expect(opusPacketSamples(new Uint8Array([0x1b, 0x03]))).toBe(3 * 2880); // SILK 60 ms, code 3, 3 frames
    expect(opusPacketSamples(new Uint8Array([0x0b, 0x03]))).toBe(3 * 960); // SILK 20 ms, code 3, 3 frames
    expect(opusPacketSamples(new Uint8Array([0x60]))).toBe(480); // hybrid 10 ms
  });
});

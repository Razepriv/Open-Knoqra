/**
 * `application/x-www-form-urlencoded` at the byte level: `+` is a space and `%XX` is one byte, with
 * no text decoding. Signatures are checked over these bytes, so a body that is not valid UTF-8, or
 * any changed byte, still changes what is signed. A `%` not followed by two hex digits is kept as
 * is, as browsers and Node's `querystring` do.
 */
export type FormPair = { key: Uint8Array; value: Uint8Array };

const AMP = 0x26;
const EQUALS = 0x3d;
const PLUS = 0x2b;
const PERCENT = 0x25;
const SPACE = 0x20;

function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

function decodeComponent(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === PLUS) {
      out.push(SPACE);
    } else if (b === PERCENT) {
      const hi = hexValue(bytes[i + 1]);
      const lo = hexValue(bytes[i + 2]);
      if (hi >= 0 && lo >= 0) {
        out.push(hi * 16 + lo);
        i += 2;
      } else {
        out.push(b);
      }
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** Every `key=value` pair in order. Empty pieces (`a&&b`) are skipped; `a` alone has an empty value. */
export function parseFormBytes(body: Uint8Array): FormPair[] {
  const pairs: FormPair[] = [];
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i < body.length && body[i] !== AMP) continue;
    const piece = body.subarray(start, i);
    start = i + 1;
    if (piece.length === 0) continue;
    const eq = piece.indexOf(EQUALS);
    const rawKey = eq === -1 ? piece : piece.subarray(0, eq);
    const rawValue = eq === -1 ? new Uint8Array(0) : piece.subarray(eq + 1);
    pairs.push({ key: decodeComponent(rawKey), value: decodeComponent(rawValue) });
  }
  return pairs;
}

/** Byte-wise order: for ASCII names, the "Unix-style case-sensitive sorting" Plivo signs with. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The form as text, first value per name. Null when any name or value is not valid UTF-8: such a
 * body cannot be a Plivo callback.
 */
export function formFields(body: Uint8Array): Record<string, string> | null {
  const fields: Record<string, string> = {};
  try {
    for (const { key, value } of parseFormBytes(body)) {
      const name = strictDecoder.decode(key);
      if (!(name in fields)) fields[name] = strictDecoder.decode(value);
    }
  } catch {
    return null;
  }
  return fields;
}

/** Encodes fields as Plivo posts them (test fixtures and the contract). */
export function encodeForm(fields: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(new URLSearchParams(fields).toString());
}

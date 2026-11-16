const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

/** Returns null when the input is not valid base64. */
export const base64ToBytes = (text: string): Uint8Array | null => {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

export const utf8ToBase64 = (text: string): string => bytesToBase64(encoder.encode(text));

/** Returns null when the input is not base64 of valid UTF-8. */
export const base64ToUtf8 = (text: string): string | null => {
  const bytes = base64ToBytes(text);
  if (bytes === null) return null;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
};

export interface DownloadOptions {
  /** Defaults to plain text. */
  mimeType?: string;
  /** A leading byte order mark makes Excel read a CSV as UTF-8, so accented names survive. */
  bom?: boolean;
}

/** Saves text as a file in the browser, without sending it anywhere. */
export function downloadTextFile(
  filename: string,
  text: string,
  options: DownloadOptions = {},
): void {
  const { mimeType = 'text/plain', bom = false } = options;
  const blob = new Blob(bom ? ['﻿', text] : [text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke a moment after the click, so the browser has started reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

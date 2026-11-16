/** Plivo XML answers for the answer URL. Every value is escaped; nothing comes from the request. */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

export type DialTarget = { kind: 'number'; e164: string } | { kind: 'user'; sipUri: string };

export const plivoXml = {
  /**
   * Connects the call to one target. `callbackUrl` receives the far end's answer and hangup
   * (`DialAction`), which drive the call's state. Without a caller id Plivo shows the caller's.
   */
  dial(input: { callerId: string | null; target: DialTarget; callbackUrl: string }): string {
    const target =
      input.target.kind === 'number'
        ? `<Number>${escapeXml(input.target.e164)}</Number>`
        : `<User>${escapeXml(input.target.sipUri)}</User>`;
    return (
      `${DECLARATION}<Response><Dial ` +
      (input.callerId === null ? '' : `callerId="${escapeXml(input.callerId)}" `) +
      `callbackUrl="${escapeXml(input.callbackUrl)}" callbackMethod="POST">${target}</Dial></Response>`
    );
  },
  /** Ends the call without connecting it. */
  hangup(): string {
    return `${DECLARATION}<Response><Hangup reason="rejected"/></Response>`;
  },
};

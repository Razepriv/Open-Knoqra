/** Strips surrounding matching quotes; returns null when the value is not quoted. */
function unquote(value: string): string | null {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.length < 2) return null;
  const end = value.indexOf(quote, 1);
  return end === -1 ? null : value.slice(1, end);
}

/**
 * Parses a `.dev.vars` file the way wrangler (dotenv) reads it: `export ` prefix allowed,
 * quoted values keep any `#`, unquoted values end at ` #` (an inline comment), CRLF tolerated.
 */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    const rest = line.slice(eq + 1).trim();
    const quoted = unquote(rest);
    vars[line.slice(0, eq).trim()] = quoted ?? rest.replace(/\s+#.*$/, '').trim();
  }
  return vars;
}

/**
 * The owner-role URL for the database the API will use: the API's host, port and database name
 * with the admin credentials. Migrations need the owner role, while `DATABASE_URL` is the
 * row-level-security app role, so the two differ only in who connects.
 */
export function migrationUrlFor(appDatabaseUrl: string, adminUrl: string): string {
  const app = new URL(appDatabaseUrl);
  const url = new URL(adminUrl);
  url.host = app.host;
  url.pathname = app.pathname;
  return url.toString();
}

/**
 * True when `value` is base64 of exactly 32 bytes, the rule the API applies to
 * CREDENTIALS_MASTER_KEY. Without one, every Telnyx connection save answers 503.
 */
export function isMasterKey(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

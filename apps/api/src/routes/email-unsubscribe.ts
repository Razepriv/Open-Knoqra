import { OpenAPIHono } from '@hono/zod-openapi';
import { BRAND_NAME, BRAND_URL, POWERED_BY } from '@knoqra/brand';
import { user, userPrefs } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { escapeHtml, palette } from '../email/layout';
import { announceNewsletterChange, saveNewsletterChoice } from '../email/newsletter';
import { UNSUBSCRIBE_PATH, verifyUnsubscribeToken } from '../email/unsubscribe';
import type { AppEnv } from '../lib/context';

/**
 * The newsletter's unsubscribe link (no session: the signed token is the authority).
 *
 * GET shows a page with one button, so mail scanners that open links do not unsubscribe anyone.
 * POST unsubscribes: the button, and mail apps' own one-click unsubscribe (RFC 8058 sends
 * `List-Unsubscribe=One-Click` to the List-Unsubscribe URL). Unsubscribing twice is fine.
 */

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ${escapeHtml(BRAND_NAME)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:${palette.page};color:${palette.text};font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:440px;width:100%;background:${palette.card};border-radius:20px;overflow:hidden;box-shadow:0 18px 40px -30px rgba(19,25,22,.45)}
header{background:${palette.ink};color:${palette.inkText};padding:24px 28px;border-bottom:4px solid ${palette.accent}}
header p{margin:0;font:600 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;color:${palette.accent}}
section{padding:28px}
h1{margin:0 0 10px;font-size:24px;line-height:1.25;letter-spacing:-.02em}
p{margin:0 0 16px;color:${palette.muted}}
button{appearance:none;border:0;border-radius:999px;background:${palette.accent};color:${palette.onAccent};font:700 16px/1 inherit;padding:16px 26px;cursor:pointer}
button:focus-visible{outline:3px solid ${palette.link};outline-offset:3px}
a{color:${palette.link}}
footer{padding:0 28px 24px;font-size:13px;color:${palette.muted}}
footer a{color:${palette.text};font-weight:600;text-decoration:none}
@media (prefers-color-scheme:dark){body{background:${palette.darkPage};color:${palette.darkText}}main{background:${palette.darkCard}}p,footer{color:${palette.darkMuted}}a{color:${palette.darkLink}}footer a{color:${palette.darkText}}}
</style>
</head>
<body>
<main>
<header><p>${escapeHtml(BRAND_NAME)}</p></header>
<section>${body}</section>
<footer><a href="${escapeHtml(BRAND_URL)}">${escapeHtml(POWERED_BY)}</a></footer>
</main>
</body>
</html>`;
}

function settingsLink(origin: string, label: string): string {
  return `<a href="${escapeHtml(new URL('/settings', origin).href)}">${escapeHtml(label)}</a>`;
}

const INVALID = (origin: string) =>
  page(
    'Link not valid',
    `<h1>This link is not valid</h1><p>It may have been cut short when it was copied. You can change which emails you get in ${settingsLink(origin, 'Settings')}.</p>`,
  );

async function checked(c: {
  env: AppEnv['Bindings'];
  req: { query(name: string): string | undefined };
}): Promise<string | null> {
  const userId = c.req.query('u') ?? '';
  const token = c.req.query('t') ?? '';
  const valid = await verifyUnsubscribeToken(c.env.BETTER_AUTH_SECRET, userId, token);
  return valid ? userId : null;
}

export const emailUnsubscribe = new OpenAPIHono<AppEnv>()
  .get(UNSUBSCRIBE_PATH, async (c) => {
    const userId = await checked(c);
    if (!userId) return c.html(INVALID(c.env.BETTER_AUTH_URL), 400, PAGE_HEADERS);
    const action = `${UNSUBSCRIBE_PATH}?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(c.req.query('t') ?? '')}`;
    return c.html(
      page(
        'Unsubscribe',
        `<h1>Unsubscribe from product news?</h1><p>You will stop getting product news and new blog posts by email. Account email, such as password resets, still arrives.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
      ),
      200,
      PAGE_HEADERS,
    );
  })
  .post(UNSUBSCRIBE_PATH, async (c) => {
    const userId = await checked(c);
    if (!userId) return c.html(INVALID(c.env.BETTER_AUTH_URL), 400, PAGE_HEADERS);
    const { db } = c.var;
    const [account] = await db
      .select({ email: user.email, name: user.name, newsletter: userPrefs.newsletter })
      .from(user)
      .leftJoin(userPrefs, eq(userPrefs.userId, user.id))
      .where(eq(user.id, userId))
      .limit(1);
    // A deleted account has nothing left to unsubscribe: answer as if it worked.
    if (account && account.newsletter !== false) {
      await saveNewsletterChoice(db, userId, false);
      c.executionCtx.waitUntil(
        announceNewsletterChange(c.env, {
          userId,
          email: account.email,
          name: account.name,
          subscribed: false,
          source: 'unsubscribe-link',
        }),
      );
    }
    return c.html(
      page(
        'Unsubscribed',
        `<h1>You are unsubscribed</h1><p>No more product news or blog posts by email. Changed your mind? Turn Product news back on in ${settingsLink(c.env.BETTER_AUTH_URL, 'Settings')}.</p>`,
      ),
      200,
      PAGE_HEADERS,
    );
  });

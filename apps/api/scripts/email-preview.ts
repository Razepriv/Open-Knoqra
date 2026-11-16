/**
 * Renders every email template to HTML and text files for review:
 *
 *   pnpm --filter @knoqra/api email:preview [out-dir]
 *
 * Default out-dir: apps/api/.email-preview (git-ignored). Uses sample data and a sample blog feed;
 * images load from https://app.knoqra.app. Set PREVIEW_ASSET_ORIGIN to load them from elsewhere,
 * for example `file://<repo>/apps/web/public` before the Desk with the images is deployed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFeed } from '../src/email/blog-feed';
import type { RenderedEmail } from '../src/email/layout';
import {
  type EmailContext,
  passwordResetEmail,
  postsDigestEmail,
  welcomeEmail,
} from '../src/email/templates';

const out = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '.email-preview'));
const ctx: EmailContext = {
  deskOrigin: 'https://app.knoqra.app',
  ...(process.env.PREVIEW_ASSET_ORIGIN ? { assetOrigin: process.env.PREVIEW_ASSET_ORIGIN } : {}),
  postalAddress: '[Postal address: EMAIL_POSTAL_ADDRESS]',
  repliesWelcome: true,
};

const blog = parseFeed(`<rss version="2.0"><channel><link>https://knoqra.app/blog/</link>
<item><title>Cold calling from the browser, without the headaches</title><link>https://knoqra.app/blog/cold-calling-from-the-browser/</link>
<description>Headsets, caller ID, local presence and the call notes that matter: a practical setup for small sales teams.</description><pubDate>Thu, 12 Nov 2026 09:00:00 GMT</pubDate><category>calling</category><category>guides</category></item>
<item><title>What US 10DLC registration really costs in 2026</title><link>https://knoqra.app/blog/us-10dlc-registration-costs/</link>
<description>Brand, campaign and carrier fees, line by line, and how long approval takes.</description><pubDate>Mon, 09 Nov 2026 09:00:00 GMT</pubDate><category>sms</category><category>us</category></item>
<item><title>The WhatsApp Business API for small teams</title><link>https://knoqra.app/blog/whatsapp-business-api-for-small-teams/</link>
<description>Templates, the 24-hour window and shared inboxes, explained without the jargon.</description><pubDate>Tue, 03 Nov 2026 09:00:00 GMT</pubDate><category>whatsapp</category></item>
</channel></rss>`);

const unsubscribe = `${ctx.deskOrigin}/api/email/unsubscribe?u=sample&t=sample`;

const emails: Record<string, RenderedEmail> = {
  'welcome-subscriber': welcomeEmail(ctx, {
    name: 'Ana Silva',
    email: 'ana@example.com',
    workspaceName: "Ana Silva's workspace",
    plan: 'No plan yet',
    number: null,
    blog,
    unsubscribeUrl: unsubscribe,
  }),
  'welcome-with-number': welcomeEmail(ctx, {
    name: 'Dana Whitfield',
    email: 'dana@example.com',
    workspaceName: 'Whitfield Realty',
    plan: 'Pro (monthly)',
    number: '+1 415 555 0123',
    blog: { home: null, posts: [] },
    unsubscribeUrl: null,
  }),
  'password-reset': passwordResetEmail(ctx, {
    email: 'ana@example.com',
    url: `${ctx.deskOrigin}/api/auth/reset-password/sample-token?callbackURL=%2Freset-password`,
  }),
  'newsletter-digest': postsDigestEmail(ctx, {
    posts: blog.posts,
    blogUrl: 'https://knoqra.app/blog/',
    unsubscribeUrl: unsubscribe,
    postalAddress: '[Postal address: EMAIL_POSTAL_ADDRESS]',
    date: new Date('2026-11-16T09:00:00Z'),
  }),
};

mkdirSync(out, { recursive: true });
const index: string[] = [];
for (const [name, email] of Object.entries(emails)) {
  writeFileSync(join(out, `${name}.html`), email.html);
  writeFileSync(join(out, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}`);
  index.push(
    `<li><a href="${name}.html">${name}</a> (<a href="${name}.txt">text</a>): ${email.subject}</li>`,
  );
}
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>Email previews</title><ul>${index.join('')}</ul>`,
);
process.stdout.write(`Wrote ${Object.keys(emails).length} emails to ${out}\n`);

import { env } from 'cloudflare:workers';
import { legalLinks, POWERED_BY } from '@knoqra/brand';
import { userPrefs } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestPosts, parseFeed, resetFeedCache } from '../src/email/blog-feed';
import { safeHref } from '../src/email/layout';
import { TERMS_VERSION } from '../src/email/newsletter';
import { passwordResetEmail, postsDigestEmail, welcomeEmail } from '../src/email/templates';
import {
  listUnsubscribeHeaders,
  UNSUBSCRIBE_PATH,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from '../src/email/unsubscribe';
import { formatNumber } from '../src/email/welcome';
import { sentEmails } from '../src/lib/email';
import { api, authPost, cookieHeader, PASSWORD, uniqueEmail, withAdminDb } from './helpers';

const CTX = { deskOrigin: 'https://app.example.test', postalAddress: '1 Example Way, Testville' };

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Blog</title>
  <link>https://example.test/blog/</link>
  <item>
    <title>Older post</title>
    <link>https://example.test/blog/older/</link>
    <description>Old news</description>
    <pubDate>Mon, 02 Nov 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Calls &amp; texts: a &quot;guide&quot;</title>
    <link>https://example.test/blog/guide/</link>
    <description>How teams &lt;really&gt; work</description>
    <pubDate>Fri, 13 Nov 2026 00:00:00 GMT</pubDate>
    <category>sms</category>
    <category>us</category>
  </item>
  <item>
    <title><![CDATA[Cdata <b>title</b>]]></title>
    <link>https://example.test/blog/cdata/</link>
    <pubDate>Wed, 11 Nov 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Bad link</title>
    <link>javascript:alert(1)</link>
  </item>
  <item>
    <title>Oldest</title>
    <link>https://example.test/blog/oldest/</link>
    <pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

function welcome(overrides: Partial<Parameters<typeof welcomeEmail>[1]> = {}) {
  return welcomeEmail(CTX, {
    name: 'Ana Silva',
    email: 'ana@example.test',
    workspaceName: "Ana Silva's workspace",
    plan: 'Starter (monthly)',
    number: '+1 415 555 0123',
    blog: parseFeed(FEED),
    unsubscribeUrl: null,
    ...overrides,
  });
}

describe('blog feed', () => {
  afterEach(() => resetFeedCache());

  it('reads the newest three posts, decoding entities and skipping bad links', () => {
    const feed = parseFeed(FEED);
    expect(feed.home).toBe('https://example.test/blog/');
    expect(feed.posts.map((p) => p.title)).toEqual([
      'Calls & texts: a "guide"',
      'Cdata title',
      'Older post',
    ]);
    expect(feed.posts[0]?.description).toBe('How teams work');
    expect(feed.posts[0]?.published?.toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(feed.posts[0]?.tags).toEqual(['sms', 'us']);
    expect(feed.posts[1]?.tags).toEqual([]);
  });

  it('gives no posts when the feed is unset, failing or unreachable', async () => {
    expect((await latestPosts(undefined)).posts).toEqual([]);
    const failing = vi.fn(async () => new Response('nope', { status: 500 }));
    expect((await latestPosts('https://example.test/rss.xml', { fetch: failing })).posts).toEqual(
      [],
    );
    const throwing = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect((await latestPosts('https://example.test/rss.xml', { fetch: throwing })).posts).toEqual(
      [],
    );
  });

  it('remembers the feed for an hour', async () => {
    const f = vi.fn(async () => new Response(FEED, { status: 200 }));
    await latestPosts('https://example.test/rss.xml', { fetch: f, now: 0 });
    await latestPosts('https://example.test/rss.xml', { fetch: f, now: 59 * 60_000 });
    expect(f).toHaveBeenCalledTimes(1);
    await latestPosts('https://example.test/rss.xml', { fetch: f, now: 61 * 60_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('welcome email', () => {
  it('shows the account, three steps, the blog and the attribution', () => {
    const { subject, html, text, headers } = welcome();
    expect(subject).toBe('Welcome to KNOQRA, Ana: your workspace is ready');
    for (const fragment of [
      'Ana Silva&#39;s workspace',
      'ana@example.test',
      'Starter (monthly)',
      '+1 415 555 0123',
      'https://app.example.test/numbers',
      'https://app.example.test/calls',
      'https://app.example.test/inbox',
      'https://app.example.test/email/knoqra-wordmark.png',
      'https://app.example.test/email/otto.png',
      'https://example.test/blog/guide/',
      'Calls &amp; texts: a &quot;guide&quot;',
      POWERED_BY,
      legalLinks.license,
      legalLinks.additionalTerms,
      legalLinks.trademarks,
      '1 Example Way, Testville',
    ]) {
      expect(html).toContain(fragment);
    }
    for (const fragment of [
      "Workspace: Ana Silva's workspace",
      'Account email: ana@example.test',
      '1. Set up your number',
      '2. Make your first call',
      '3. Try messaging',
      'Calls & texts: a "guide"',
      `${POWERED_BY}: https://knoqra.app`,
    ]) {
      expect(text).toContain(fragment);
    }
    expect(text).not.toMatch(/<[a-z]/i);
    expect(headers).toBeUndefined();
    expect(html).toContain('Turn on Product news in Settings');
  });

  it('adds the unsubscribe link and List-Unsubscribe headers for a subscriber', () => {
    const url = 'https://app.example.test/api/email/unsubscribe?u=U&t=T';
    const { html, text, headers } = welcome({ unsubscribeUrl: url });
    expect(headers).toEqual(listUnsubscribeHeaders(url));
    expect(headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(html).toContain('https://app.example.test/api/email/unsubscribe?u=U&amp;t=T');
    expect(text).toContain(`Unsubscribe: ${url}`);
    expect(html).not.toContain('Turn on Product news in Settings');
  });

  it('leaves out the blog and plan when there are none, and escapes user input', () => {
    const { html, text } = welcome({
      name: '<img src=x onerror=alert(1)>',
      plan: null,
      number: null,
      blog: { home: null, posts: [] },
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('Fresh from the blog');
    expect(text).not.toContain('Plan:');
    expect(text).toContain('Number: None yet');
    expect(text).toContain('1. Connect or get a number');
  });
});

describe('password reset email', () => {
  it('carries the link in both versions and no unsubscribe', () => {
    const url = 'https://app.example.test/api/auth/reset-password/TOKEN?callbackURL=%2Freset';
    const { subject, html, text, headers } = passwordResetEmail(CTX, {
      email: 'ana@example.test',
      url,
    });
    expect(subject).toBe('Reset your KNOQRA password');
    expect(html).toContain('https://app.example.test/api/auth/reset-password/TOKEN');
    expect(text).toContain(url);
    expect(html).toContain(POWERED_BY);
    expect(html).not.toContain('Unsubscribe');
    expect(headers).toBeUndefined();
  });
});

describe('posts digest email (the Dispatch)', () => {
  const digest = () =>
    postsDigestEmail(CTX, {
      posts: parseFeed(FEED).posts,
      blogUrl: 'https://example.test/blog/',
      unsubscribeUrl: '{{{RESEND_UNSUBSCRIBE_URL}}}',
      postalAddress: '1 Example Way, Testville',
      date: new Date('2026-11-16T00:00:00Z'),
    });

  it('keeps the Resend merge tag and puts the postal address on the postage label', () => {
    const { html, text } = digest();
    expect(html).toContain('href="{{{RESEND_UNSUBSCRIBE_URL}}}"');
    expect(text).toContain('Unsubscribe: {{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(html).toContain('1 Example Way, Testville');
    expect(text).toContain('Posted by KNOQRA · Nov 16, 2026\n1 Example Way, Testville');
  });

  it('builds the issue: masthead art, Otto, lead story, topics and the rest', () => {
    const { subject, html, text } = digest();
    expect(subject).toBe('KNOQRA Dispatch: Calls & texts: a "guide"');
    expect(html).toContain('https://app.example.test/email/dispatch.gif');
    expect(html).toContain('Dispatch · Nov 2026');
    expect(html).toContain('Otto · Dispatch');
    expect(html).toContain('Lead story · SMS · Nov 13, 2026');
    // Topic pills come from the posts' tags.
    expect(html).toContain('&nbsp;&nbsp;SMS</td>');
    expect(html).toContain('&nbsp;&nbsp;US</td>');
    expect(text).toContain('LEAD STORY');
    expect(text).toContain('IN THIS ISSUE · 03');
    for (const url of [
      'https://example.test/blog/guide/',
      'https://example.test/blog/cdata/',
      'https://example.test/blog/older/',
    ]) {
      expect(text).toContain(url);
    }
    expect(html).toContain(POWERED_BY);
  });
});

describe('links', () => {
  it('only lets http(s), mailto and merge tags into an href', () => {
    expect(safeHref('javascript:alert(1)')).toBe('#');
    expect(safeHref('data:text/html,hi')).toBe('#');
    expect(safeHref('https://x.test/a?b=1&c=2')).toBe('https://x.test/a?b=1&amp;c=2');
    expect(safeHref('mailto:hello@x.test')).toBe('mailto:hello@x.test');
    expect(safeHref('{{{RESEND_UNSUBSCRIBE_URL}}}')).toBe('{{{RESEND_UNSUBSCRIBE_URL}}}');
    expect(safeHref('{{{x}}}')).toBe('#');
  });

  it('formats US numbers for reading', () => {
    expect(formatNumber('+14155550123')).toBe('+1 415 555 0123');
    expect(formatNumber('+442071234567')).toBe('+442071234567');
  });
});

describe('unsubscribe token', () => {
  it('verifies only for the same user and secret', async () => {
    const token = await unsubscribeToken('secret-a', 'user-1');
    expect(await verifyUnsubscribeToken('secret-a', 'user-1', token)).toBe(true);
    expect(await verifyUnsubscribeToken('secret-a', 'user-2', token)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-b', 'user-1', token)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-a', 'user-1', `${token}x`)).toBe(false);
    expect(await verifyUnsubscribeToken('secret-a', 'user-1', '')).toBe(false);
  });
});

async function signUpWith(email: string, body: Record<string, unknown> = {}) {
  const r = await authPost('/api/auth/sign-up/email', {
    email,
    password: PASSWORD,
    name: 'Mail Tester',
    ...body,
  });
  expect(r.status).toBe(200);
  const json = (await r.json()) as { user: { id: string } };
  return { cookie: cookieHeader(r), userId: json.user.id };
}

async function newsletterOf(userId: string) {
  const [row] = await withAdminDb((db) =>
    db.select().from(userPrefs).where(eq(userPrefs.userId, userId)),
  );
  return row;
}

async function welcomeTo(email: string) {
  return vi.waitFor(() => {
    const found = sentEmails.find((m) => m.to === email && m.subject.startsWith('Welcome'));
    if (!found) throw new Error('no welcome email yet');
    return found;
  });
}

describe('terms acceptance at sign-up', () => {
  it('records when and which version of the terms the user accepted', async () => {
    const before = Date.now();
    const { userId } = await signUpWith(uniqueEmail('terms'), { acceptTerms: true });
    const row = await newsletterOf(userId);
    expect(row?.termsAcceptedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.termsVersion).toBe(TERMS_VERSION);
  });

  it('records nothing when the form does not send it (older mobile builds)', async () => {
    const { userId } = await signUpWith(uniqueEmail('noterms'));
    const row = await newsletterOf(userId);
    expect(row?.termsAcceptedAt ?? null).toBeNull();
  });
});

describe('sign-up mail and the newsletter choice', () => {
  it('sends a welcome email and stores no opt-in by default', async () => {
    const email = uniqueEmail('welcome');
    const { userId } = await signUpWith(email);
    const mail = await welcomeTo(email);
    expect(mail.html).toContain('Mail Tester&#39;s workspace');
    expect(mail.text).toContain(`Account email: ${email}`);
    expect(mail.headers).toBeUndefined();
    expect((await newsletterOf(userId))?.newsletter ?? false).toBe(false);
  });

  it('stores the opt-in with a time and links a working unsubscribe', async () => {
    const email = uniqueEmail('optin');
    const before = Date.now();
    const { userId, cookie } = await signUpWith(email, { newsletter: true });
    const row = await newsletterOf(userId);
    expect(row?.newsletter).toBe(true);
    expect(row?.newsletterUpdatedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const mail = await welcomeTo(email);
    const header = mail.headers?.['List-Unsubscribe'] ?? '';
    const url = new URL(header.slice(1, -1));
    expect(url.pathname).toBe(UNSUBSCRIBE_PATH);
    expect(url.href).toBe(
      await unsubscribeUrl(env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET, userId),
    );

    // The page does not unsubscribe by itself (link scanners open it).
    const page = await api(`${url.pathname}${url.search}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Unsubscribe from product news?');
    expect((await newsletterOf(userId))?.newsletter).toBe(true);

    // Mail apps' one-click unsubscribe (RFC 8058).
    const oneClick = await api(`${url.pathname}${url.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    expect(await oneClick.text()).toContain('You are unsubscribed');
    expect((await newsletterOf(userId))?.newsletter).toBe(false);

    const prefs = (await (await api('/api/v1/me/prefs', { headers: { cookie } })).json()) as {
      data: { newsletter: boolean };
    };
    expect(prefs.data.newsletter).toBe(false);
  });

  it('rejects a forged or mismatched token', async () => {
    const { userId } = await signUpWith(uniqueEmail('forged'), { newsletter: true });
    const other = await unsubscribeToken(env.BETTER_AUTH_SECRET, 'someone-else');
    for (const query of [`u=${userId}&t=${other}`, `u=${userId}&t=`, 't=abc']) {
      const r = await api(`${UNSUBSCRIBE_PATH}?${query}`, { method: 'POST' });
      expect(r.status).toBe(400);
    }
    expect((await newsletterOf(userId))?.newsletter).toBe(true);
  });

  it('turns the newsletter on and off from Settings, stamping each change', async () => {
    const { userId, cookie } = await signUpWith(uniqueEmail('toggle'));
    const set = async (newsletter: boolean) => {
      const r = await api('/api/v1/me/prefs', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ newsletter }),
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { data: { newsletter: boolean } }).data.newsletter;
    };
    expect(await set(true)).toBe(true);
    const on = await newsletterOf(userId);
    expect(on?.newsletterUpdatedAt).toBeInstanceOf(Date);
    expect(await set(false)).toBe(false);
    const off = await newsletterOf(userId);
    expect(off?.newsletter).toBe(false);
    expect(off?.newsletterUpdatedAt?.getTime()).toBeGreaterThanOrEqual(
      on?.newsletterUpdatedAt?.getTime() ?? 0,
    );
  });
});

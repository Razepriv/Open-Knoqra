import { BRAND_NAME } from '@knoqra/brand';
import type { BlogFeed } from './blog-feed';
import {
  button,
  buttonPair,
  chat,
  details,
  divider,
  escapeHtml,
  featuredPost,
  heading,
  kicker,
  links,
  note,
  type Part,
  type PostSummary,
  palette,
  paragraph,
  postGrid,
  postmark,
  type RenderedEmail,
  renderLayout,
  steps,
  tagLabel,
} from './layout';
import { listUnsubscribeHeaders } from './unsubscribe';

/** What every template needs to know about the deployment sending it. */
export interface EmailContext {
  /** The Desk's origin: links into the app and, unless `assetOrigin` is set, the hosted images. */
  deskOrigin: string;
  /** Where `/email/*.png` are served from, when not the Desk (previews). */
  assetOrigin?: string;
  /** The sender's postal address. Shown in every footer when set; marketing mail needs it. */
  postalAddress?: string | null;
  /** Replies reach a person (EMAIL_REPLY_TO is set). */
  repliesWelcome?: boolean;
}

function desk(ctx: EmailContext, path = '/'): string {
  return new URL(path, ctx.deskOrigin).href;
}

function assets(ctx: EmailContext): string {
  return (ctx.assetOrigin ?? ctx.deskOrigin).replace(/\/+$/, '');
}

/** "03": issue counts and numbers read like the walkthrough's step numbers. */
const two = (n: number) => String(n).padStart(2, '0');

/** The product's channels, as pills under the headline (the sign-up screen shows the same). */
const CHANNEL_PILLS = [{ label: 'Calls' }, { label: 'SMS' }, { label: 'WhatsApp' }] as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
}

/** A long link, shown whole so it can be copied when the button does not work. */
function rawLink(href: string): Part {
  return {
    html: `<p class="k-cell k-muted" style="margin:0 0 20px 0;padding:12px 14px;background-color:${palette.cell};border-radius:10px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:${palette.muted};word-break:break-all;">${escapeHtml(href)}</p>`,
    text: href,
  };
}

export interface WelcomeData {
  name: string;
  email: string;
  workspaceName: string;
  /** The plan's name, or null when the edition has none to show. */
  plan: string | null;
  /** The workspace's first active number, formatted, or null. */
  number: string | null;
  blog: BlogFeed;
  /** Set when the person opted in to the newsletter at sign-up. */
  unsubscribeUrl: string | null;
}

/** Sent once, right after sign-up. */
export function welcomeEmail(ctx: EmailContext, data: WelcomeData): RenderedEmail {
  const first = firstName(data.name);
  const subject = `Welcome to ${BRAND_NAME}, ${first}: your workspace is ready`;
  const rows: Array<readonly [string, string]> = [
    ['Workspace', data.workspaceName],
    ['Account email', data.email],
  ];
  if (data.plan) rows.push(['Plan', data.plan]);
  rows.push(['Number', data.number ?? 'None yet']);

  const body: Part[] = [
    heading('Your account'),
    details(rows),
    button({ label: 'Open your Desk', href: desk(ctx) }),
    heading('Get going in three steps'),
    steps([
      data.number
        ? {
            title: 'Set up your number',
            body: `${data.number} is in your workspace. Choose whether it takes calls, messages or both.`,
            action: { label: 'Open Numbers', href: desk(ctx, '/numbers') },
          }
        : {
            title: 'Connect or get a number',
            body: 'Bring the number you already use, or pick a new local one in a few clicks.',
            action: { label: 'Open Numbers', href: desk(ctx, '/numbers') },
          },
      {
        title: 'Make your first call',
        body: 'Dial from the browser with any headset. Every call lands on the contact’s timeline.',
        action: { label: 'Open Calls', href: desk(ctx, '/calls') },
      },
      {
        title: 'Try messaging',
        body: 'Send a text or a WhatsApp message and keep every reply in one shared inbox.',
        action: { label: 'Open Inbox', href: desk(ctx, '/inbox') },
      },
    ]),
  ];

  if (data.blog.posts.length > 0) {
    body.push(
      divider(),
      kicker('Fresh from the blog', two(data.blog.posts.length)),
      postGrid(data.blog.posts),
    );
    if (data.blog.home) body.push(links([{ label: 'Read the blog', href: data.blog.home }]));
  }

  body.push(divider());
  if (ctx.repliesWelcome) {
    body.push(paragraph('Questions or stuck on a step? Reply to this email: a person reads it.'));
  }
  if (!data.unsubscribeUrl) {
    body.push(note('Want new posts and product news by email? Turn on Product news in Settings.'));
  }

  const { html, text } = renderLayout({
    subject,
    preheader: 'Your account details, three first steps and the latest from the blog.',
    eyebrow: 'Welcome aboard',
    meta: 'Workspace · Ready',
    title: `Welcome to ${BRAND_NAME}, ${first}.`,
    lede: 'Your workspace is ready: calls, texts and WhatsApp for your whole team, with every contact’s history in one calm place.',
    mascot: true,
    pills: CHANNEL_PILLS,
    body,
    assetOrigin: ctx.assetOrigin ?? ctx.deskOrigin,
    footer: {
      reason: `You’re getting this because you created a ${BRAND_NAME} account with ${data.email}.`,
      postalAddress: ctx.postalAddress,
      unsubscribeUrl: data.unsubscribeUrl,
      preferencesUrl: desk(ctx, '/settings'),
    },
  });
  return {
    subject,
    html,
    text,
    ...(data.unsubscribeUrl ? { headers: listUnsubscribeHeaders(data.unsubscribeUrl) } : {}),
  };
}

export interface PasswordResetData {
  email: string;
  url: string;
}

/** The reset link. It is a bearer credential: never log the result. */
export function passwordResetEmail(ctx: EmailContext, data: PasswordResetData): RenderedEmail {
  const subject = `Reset your ${BRAND_NAME} password`;
  const { html, text } = renderLayout({
    subject,
    preheader: 'Choose a new password. The link works once and expires in an hour.',
    eyebrow: 'Account security',
    meta: 'Link expires in 1 hour',
    title: 'Reset your password',
    lede: `Someone asked to reset the password for ${data.email}. If it was you, choose a new one below.`,
    body: [
      button({ label: 'Choose a new password', href: data.url }),
      note('The link works once and expires in an hour. If the button does not work, copy it:'),
      rawLink(data.url),
      divider(),
      note(
        'Did not ask for this? Ignore this email and your password stays the same. Resetting it signs you out on every other device.',
      ),
    ],
    assetOrigin: ctx.assetOrigin ?? ctx.deskOrigin,
    footer: {
      reason: `You’re getting this because a password reset was requested for the ${BRAND_NAME} account ${data.email}.`,
      postalAddress: ctx.postalAddress,
    },
  });
  return { subject, html, text };
}

export interface PostsDigestData {
  posts: readonly PostSummary[];
  /** The blog's home page. */
  blogUrl: string;
  /**
   * The unsubscribe link. For a Resend Broadcast, the `{{{RESEND_UNSUBSCRIBE_URL}}}` merge tag,
   * which Resend fills in per contact.
   */
  unsubscribeUrl: string;
  /** Marketing mail must carry the sender's postal address: it goes on the postage label. */
  postalAddress: string;
  subject?: string;
  /** The masthead headline. Default "Notes from the line." */
  title?: string;
  /** Otto's note at the top of the issue. Default: a pointer to the lead story. */
  note?: string;
  /** The issue's date (masthead and postmark). Default now. */
  date?: Date;
}

const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Up to three topics of the issue, from the posts' tags; the channels when there are none. */
function topicPills(items: readonly PostSummary[]): Array<{ label: string }> {
  const seen = new Set<string>();
  for (const post of items) {
    for (const slug of post.tags ?? []) {
      const label = tagLabel(slug);
      if (!seen.has(label)) seen.add(label);
    }
  }
  const topics = [...seen].slice(0, 3).map((label) => ({ label }));
  return topics.length > 0 ? topics : [...CHANNEL_PILLS];
}

/**
 * "The KNOQRA Dispatch": the new-posts newsletter for people who opted in. A masthead with the
 * site's live call card (an animated waveform, `dispatch.gif`), Otto's note as chat bubbles, the
 * lead story as the walkthrough's citron "current" card, the rest as step cards, and the postal
 * address as a postage label.
 */
export function postsDigestEmail(ctx: EmailContext, data: PostsDigestData): RenderedEmail {
  const [lead, ...rest] = data.posts;
  const count = data.posts.length;
  const date = data.date ?? new Date();
  const postsWord = count === 1 ? 'post' : 'posts';
  const subject =
    data.subject ?? (lead ? `${BRAND_NAME} Dispatch: ${lead.title}` : `${BRAND_NAME} Dispatch`);
  const otto = `${assets(ctx)}/email/otto.png`;
  const body: Part[] = [
    chat(
      {
        from: 'Otto · Dispatch',
        text:
          data.note ??
          (lead
            ? `${count} new ${postsWord} this time. Start with “${lead.title}”, then hit reply and tell us what to write next.`
            : 'Hit reply and tell us what to write next.'),
        reply: { text: 'Reading it after this call.', meta: 'Delivered ✓✓' },
      },
      otto,
    ),
    kicker('In this issue', two(count)),
  ];
  if (lead) body.push(featuredPost(lead));
  if (rest.length > 0) body.push(postGrid(rest, 1));
  body.push(
    buttonPair(
      { label: 'Read the blog', href: data.blogUrl },
      { label: 'Open your Desk', href: desk(ctx) },
    ),
    postmark(data.postalAddress, otto, `Posted by ${BRAND_NAME} · ${DAY.format(date)}`),
  );

  const { html, text } = renderLayout({
    subject,
    preheader: lead?.description || `${count} new ${postsWord} to read.`,
    eyebrow: `From the ${BRAND_NAME} blog · ${two(count)} new`,
    meta: `Dispatch · ${MONTH.format(date)}`,
    title: data.title ?? 'Notes from the line.',
    lede: `${count} new ${postsWord} on calls, texts and WhatsApp for teams that live on the phone.`,
    pills: topicPills(data.posts),
    art: {
      path: '/email/dispatch.gif',
      width: 520,
      height: 222,
      alt: `The ${BRAND_NAME} Dispatch: a live call card with Otto and a moving waveform`,
      href: data.blogUrl,
    },
    body,
    assetOrigin: assets(ctx),
    footer: {
      reason: `You’re getting this because you asked for ${BRAND_NAME} product news and new blog posts.`,
      unsubscribeUrl: data.unsubscribeUrl,
      preferencesUrl: desk(ctx, '/settings'),
    },
  });
  return { subject, html, text };
}

import { BRAND_NAME, BRAND_URL, COPYRIGHT_NOTICE, legalLinks, POWERED_BY } from '@knoqra/brand';
import { accent, dark, gradients, light } from '@knoqra/tokens';

/**
 * The branded email layout every message KNOQRA sends goes through. Table-based HTML with inline
 * styles (Outlook and Gmail ignore most CSS), plus `<style>` blocks that only add the web fonts,
 * dark mode and the phone layout for the clients that read them. Each block renders to HTML and
 * plain text together, so the two versions never drift apart.
 *
 * The look follows the marketing site and the Desk: a dark radial masthead with mono `·` labels,
 * Space Grotesk headlines, citron actions, walkthrough-style cards with gradient number tiles and
 * mint chat bubbles.
 */

/** Colours from @knoqra/tokens, so mail matches the Desk. */
export const palette = {
  page: light['--shell'],
  card: '#FFFFFF',
  ink: light['--mark-bg'],
  text: light['--text'],
  muted: light['--muted'],
  link: light['--line'],
  accent: accent.base,
  onAccent: light['--on-accent'],
  cell: light['--cell'],
  border: light['--ring-track'],
  inkText: dark['--text'],
  inkSoft: light['--streak-soft'],
  inkMuted: light['--streak-muted'],
  inkLine: light['--streak-line'],
  amber: '#E8B46A',
  mint: '#8EDDB5',
  mintSoft: '#C4F2DA',
  mintText: '#1D5A3F',
  darkPage: dark['--shell'],
  darkCard: dark['--cell'],
  darkCell: dark['--pressed'],
  darkText: dark['--text'],
  darkMuted: dark['--muted'],
  darkBorder: dark['--ring-track'],
  darkLink: accent.base,
} as const;

/** The masthead's glow, as on the site's hero and the Desk's streak panel. */
const HERO_GLOW = light['--streak-panel'];

/** Number tiles and pill dots cycle through the walkthrough's colours. */
const TILES = [
  { gradient: gradients.mint, solid: '#A9E8C8', dot: '#8EDDB5' },
  { gradient: gradients.peri, solid: '#B8C6FF', dot: '#9DB0FF' },
  { gradient: gradients.apr, solid: '#FBBF9B', dot: '#F7A676' },
] as const;

const tile = (index: number) => TILES[index % TILES.length] ?? TILES[0];

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const DISPLAY = `'Space Grotesk',${FONT}`;
const MONO = "'IBM Plex Mono','SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";

/** One block of an email, in both formats. */
export interface Part {
  html: string;
  text: string;
}

export interface EmailLink {
  label: string;
  href: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and mailto links reach an href; anything else becomes `#`. */
export function safeHref(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') {
      return escapeHtml(url.href);
    }
  } catch {
    // Merge tags such as {{{RESEND_UNSUBSCRIBE_URL}}} are not URLs: let the sender fill them in.
    if (/^\{\{\{[A-Z_]+\}\}\}$/.test(href)) return href;
  }
  return '#';
}

function link(label: string, href: string, color: string = palette.link): string {
  return `<a href="${safeHref(href)}" class="k-link" style="color:${color};text-decoration:underline;text-underline-offset:2px;">${escapeHtml(label)}</a>`;
}

const spacer = (height: number) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:${height}px;line-height:${height}px;font-size:0;">&nbsp;</td></tr></table>`;

export function paragraph(value: string): Part {
  return {
    html: `<p class="k-text" style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:26px;color:${palette.text};">${escapeHtml(value)}</p>`,
    text: value,
  };
}

/** A small grey line: notes, fallbacks and asides. */
export function note(value: string): Part {
  return {
    html: `<p class="k-muted" style="margin:0 0 16px 0;font-family:${FONT};font-size:14px;line-height:22px;color:${palette.muted};">${escapeHtml(value)}</p>`,
    text: value,
  };
}

export function heading(value: string): Part {
  return {
    html: `<h2 class="k-text" style="margin:8px 0 14px 0;font-family:${DISPLAY};font-size:21px;line-height:27px;font-weight:500;letter-spacing:-0.015em;color:${palette.text};">${escapeHtml(value)}</h2>`,
    text: `${value}\n${'-'.repeat(value.length)}`,
  };
}

/** A mono caps label with `·` separators, as on the site ("IN THIS ISSUE · 03"). */
export function kicker(...words: string[]): Part {
  const value = words.join(' · ');
  return {
    html: `<p class="k-muted" style="margin:6px 0 14px 0;font-family:${MONO};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${palette.muted};">${escapeHtml(value)}</p>`,
    text: value.toUpperCase(),
  };
}

function pill(action: EmailLink, variant: 'accent' | 'ink'): string {
  const href = safeHref(action.href);
  const label = escapeHtml(action.label);
  const bg = variant === 'accent' ? palette.accent : palette.ink;
  const fg = variant === 'accent' ? palette.onAccent : palette.inkText;
  const width = Math.max(150, action.label.length * 9 + 60);
  const shadow =
    variant === 'accent'
      ? 'box-shadow:0 8px 18px -10px rgba(110,150,30,.8);'
      : `border:1px solid ${palette.inkLine};`;
  return `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:${width}px;" arcsize="50%" stroke="f" fillcolor="${bg}"><w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" class="k-button" style="display:inline-block;background-color:${bg};color:${fg};font-family:${FONT};font-size:16px;line-height:48px;font-weight:600;text-decoration:none;padding:0 26px;border-radius:999px;${shadow}mso-hide:all;">${label}&nbsp;&rarr;</a><!--<![endif]-->`;
}

/** A citron call to action that survives Outlook (VML) and image blocking. */
export function button(action: EmailLink): Part {
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td>${pill(action, 'accent')}</td></tr></table>`,
    text: `${action.label}: ${action.href}`,
  };
}

/** The main action in citron with a quieter dark one beside it (stacked on phones). */
export function buttonPair(primary: EmailLink, secondary: EmailLink): Part {
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr>
<td class="k-col" style="padding:0 10px 10px 0;">${pill(primary, 'accent')}</td>
<td class="k-col" style="padding:0 0 10px 0;">${pill(secondary, 'ink')}</td>
</tr></table>`,
    text: `${primary.label}: ${primary.href}\n${secondary.label}: ${secondary.href}`,
  };
}

/** Label and value rows on a soft panel, for account details. */
export function details(rows: ReadonlyArray<readonly [label: string, value: string]>): Part {
  const cells = rows
    .map(
      ([label, value], index) => `<tr>
<td class="k-muted k-row k-row-l" style="padding:13px 18px;${index > 0 ? `border-top:1px solid ${palette.border};` : ''}font-family:${MONO};font-size:11px;line-height:20px;letter-spacing:0.06em;text-transform:uppercase;color:${palette.muted};white-space:nowrap;width:38%;">${escapeHtml(label)}</td>
<td class="k-text k-row" style="padding:13px 18px;${index > 0 ? `border-top:1px solid ${palette.border};` : ''}font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${palette.text};word-break:break-word;">${escapeHtml(value)}</td>
</tr>`,
    )
    .join('');
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="k-cell" style="margin:4px 0 28px 0;background-color:${palette.cell};border-radius:16px;border-collapse:separate;">${cells}</table>`,
    text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
  };
}

/** A walkthrough number tile: a soft gradient square with a mono "01". */
function numberTile(index: number, size = 40, plain = false): string {
  const t = tile(index);
  const fill = plain
    ? 'background-color:#FFFFFF;'
    : `background-color:${t.solid};background-image:${t.gradient};`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="${size}" height="${size}" style="width:${size}px;height:${size}px;${fill}border-radius:12px;font-family:${MONO};font-size:13px;line-height:${size}px;font-weight:500;color:${palette.text};">${String(index + 1).padStart(2, '0')}</td></tr></table>`;
}

export interface Step {
  title: string;
  body: string;
  action: EmailLink;
}

/** Numbered getting-started steps, each with its own link. */
export function steps(items: readonly Step[]): Part {
  const rows = items
    .map(
      (item, index) => `<tr>
<td valign="top" style="padding:0 16px 24px 0;width:40px;">${numberTile(index)}</td>
<td valign="top" style="padding:0 0 24px 0;">
<p class="k-text" style="margin:2px 0 4px 0;font-family:${DISPLAY};font-size:18px;line-height:24px;font-weight:500;letter-spacing:-0.01em;color:${palette.text};">${escapeHtml(item.title)}</p>
<p class="k-muted" style="margin:0 0 6px 0;font-family:${FONT};font-size:14px;line-height:22px;color:${palette.muted};">${escapeHtml(item.body)}</p>
<p style="margin:0;font-family:${FONT};font-size:14px;line-height:22px;font-weight:600;">${link(`${item.action.label} →`, item.action.href)}</p>
</td>
</tr>`,
    )
    .join('');
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">${rows}</table>`,
    text: items
      .map(
        (item, index) =>
          `${index + 1}. ${item.title}\n   ${item.body}\n   ${item.action.label}: ${item.action.href}`,
      )
      .join('\n\n'),
  };
}

export interface PostSummary {
  title: string;
  url: string;
  description: string;
  published: Date | null;
  /** The feed's categories (blog tag slugs such as `sms`). */
  tags?: readonly string[];
}

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const TAG_LABELS: Record<string, string> = {
  sms: 'SMS',
  us: 'US',
  whatsapp: 'WhatsApp',
  '10dlc': '10DLC',
};

/** A blog tag slug as people read it: `sms` is SMS, `calling` is Calling. */
export function tagLabel(slug: string): string {
  const key = slug.trim().toLowerCase();
  return TAG_LABELS[key] ?? key.replace(/(^|[\s-])\w/g, (c) => c.toUpperCase()).replace(/-/g, ' ');
}

function postMeta(post: PostSummary): string {
  const parts: string[] = [];
  const first = post.tags?.[0];
  if (first) parts.push(tagLabel(first));
  if (post.published) parts.push(DATE.format(post.published));
  return parts.join(' · ');
}

function postText(post: PostSummary): string {
  const meta = postMeta(post);
  return [
    `* ${post.title}`,
    meta ? `  ${meta}` : '',
    post.description ? `  ${post.description}` : '',
    `  ${post.url}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The lead story: the walkthrough's "current" step, a citron card with its own button. */
export function featuredPost(post: PostSummary, index = 0): Part {
  const meta = postMeta(post);
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;border-collapse:separate;"><tr>
<td class="k-px-sm" style="background-color:${palette.accent};background-image:${gradients.hl};border-radius:24px;padding:22px 24px 24px 24px;box-shadow:0 22px 36px -22px rgba(110,150,30,.9);">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle">${numberTile(index, 40, true)}</td>
<td valign="middle" align="right" style="font-family:${MONO};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#3F5A1C;">Lead story${meta ? ` · ${escapeHtml(meta)}` : ''}</td>
</tr></table>
<p style="margin:18px 0 8px 0;font-family:${DISPLAY};font-size:26px;line-height:31px;font-weight:500;letter-spacing:-0.025em;"><a href="${safeHref(post.url)}" style="color:${palette.text};text-decoration:none;">${escapeHtml(post.title)}</a></p>
${post.description ? `<p style="margin:0 0 18px 0;font-family:${FONT};font-size:15px;line-height:23px;color:#33402F;">${escapeHtml(post.description)}</p>` : ''}
${pill({ label: 'Read the post', href: post.url }, 'ink')}
</td></tr></table>`,
    text: `LEAD STORY\n${postText(post)}`,
  };
}

function gridCard(post: PostSummary, index: number): string {
  const meta = postMeta(post);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle">${numberTile(index, 36)}</td>
${meta ? `<td valign="middle" align="right" class="k-muted" style="font-family:${MONO};font-size:10.5px;line-height:14px;font-weight:500;letter-spacing:0.07em;text-transform:uppercase;color:${palette.muted};">${escapeHtml(meta)}</td>` : ''}
</tr></table>
<p style="margin:16px 0 6px 0;font-family:${DISPLAY};font-size:18px;line-height:23px;font-weight:500;letter-spacing:-0.015em;"><a href="${safeHref(post.url)}" class="k-text" style="color:${palette.text};text-decoration:none;">${escapeHtml(post.title)}</a></p>
${post.description ? `<p class="k-muted" style="margin:0 0 12px 0;font-family:${FONT};font-size:14px;line-height:21px;color:${palette.muted};">${escapeHtml(post.description)}</p>` : ''}
<p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;">${link('Read →', post.url)}</p>`;
}

/**
 * Posts as walkthrough step cards, two to a row (one per row on phones). `start` numbers the
 * tiles after a lead story.
 */
export function postGrid(items: readonly PostSummary[], start = 0): Part {
  const cell = (post: PostSummary, index: number, span = false) =>
    `<td class="k-cell k-col" valign="top" ${span ? 'colspan="3" ' : 'width="216" '}style="background-color:${palette.cell};border-radius:20px;padding:18px 18px 20px 18px;border:1px solid ${palette.border};">${gridCard(post, index)}</td>`;
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const a = items[i];
    const b = items[i + 1];
    if (!a) break;
    rows.push(
      b
        ? `<tr>${cell(a, start + i)}<td class="k-gap" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>${cell(b, start + i + 1)}</tr>`
        : `<tr>${cell(a, start + i, true)}</tr>`,
    );
    rows.push(
      `<tr><td colspan="3" style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>`,
    );
  }
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;border-collapse:separate;">${rows.join('')}</table>`,
    text: items.map(postText).join('\n\n'),
  };
}

export interface ChatNote {
  /** Who speaks, in the mono meta line ("Otto · Dispatch"). */
  from: string;
  text: string;
  /** The reader's reply bubble, mint, on the right. */
  reply?: { text: string; meta: string };
}

/** A note as the Desk's conversation bubbles: Otto on the left, the reader's mint reply on the right. */
export function chat(note: ChatNote, avatar: string): Part {
  const reply = note.reply
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 24px 0;"><tr><td align="right">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td style="background-color:${palette.mintSoft};border-radius:18px 18px 6px 18px;padding:12px 16px;">
<p style="margin:0 0 4px 0;font-family:${FONT};font-size:15px;line-height:22px;color:${palette.mintText};">${escapeHtml(note.reply.text)}</p>
<p style="margin:0;font-family:${MONO};font-size:10.5px;line-height:14px;font-weight:500;letter-spacing:0.07em;text-transform:uppercase;color:${palette.mintText};">${escapeHtml(note.reply.meta)}</p>
</td></tr></table></td></tr></table>`
    : '';
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${note.reply ? 0 : 26}px 0;"><tr>
<td valign="bottom" width="44" style="width:44px;padding:0 10px 0 0;"><img src="${escapeHtml(avatar)}" width="40" height="40" alt="Otto" style="display:block;width:40px;height:40px;border-radius:999px;border:0;"></td>
<td valign="bottom"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td class="k-cell" style="background-color:${palette.cell};border-radius:18px 18px 18px 6px;padding:12px 16px;max-width:420px;">
<p style="margin:0 0 4px 0;font-family:${MONO};font-size:10.5px;line-height:14px;font-weight:500;letter-spacing:0.07em;text-transform:uppercase;color:${palette.link};" class="k-link">${escapeHtml(note.from)}</p>
<p class="k-text" style="margin:0;font-family:${FONT};font-size:15px;line-height:23px;color:${palette.text};">${escapeHtml(note.text)}</p>
</td></tr></table></td>
</tr></table>${reply}`,
    text: `${note.from}: ${note.text}${note.reply ? `\nYou: ${note.reply.text}` : ''}`,
  };
}

/** A row of plain links, for the quieter destinations under the main action. */
export function links(items: readonly EmailLink[]): Part {
  return {
    html: `<p class="k-muted" style="margin:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:24px;color:${palette.muted};">${items
      .map((item) => link(item.label, item.href))
      .join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;')}</p>`,
    text: items.map((item) => `${item.label}: ${item.href}`).join('\n'),
  };
}

export function divider(): Part {
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 24px 0;"><tr><td class="k-rule" style="border-top:1px solid ${palette.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`,
    text: '',
  };
}

/**
 * The sender's postal address as a postage label, after the site's mail mock: a perforated stamp
 * with Otto beside a mono address block.
 */
export function postmark(address: string, stamp: string, line: string): Part {
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px 0;background-color:#F6F1E7;border-radius:16px;border-collapse:separate;"><tr>
<td valign="top" width="76" style="width:76px;padding:16px 0 16px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:2px dashed #C9B48F;border-radius:6px;padding:5px;background-color:#FFFFFF;"><img src="${escapeHtml(stamp)}" width="46" height="46" alt="" style="display:block;width:46px;height:46px;border-radius:4px;border:0;"></td></tr></table></td>
<td valign="top" style="padding:16px 18px 16px 14px;">
<p style="margin:0 0 6px 0;font-family:${MONO};font-size:10.5px;line-height:14px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#8A6A3A;">${escapeHtml(line)}</p>
<p style="margin:0;font-family:${MONO};font-size:12px;line-height:18px;font-weight:500;color:#4A3B22;">${escapeHtml(address)}</p>
</td></tr></table>`,
    text: `${line}\n${address}`,
  };
}

export interface Footer {
  /** Why this person gets this email. */
  reason: string;
  /** The sender's postal address. Required in marketing mail; shown whenever it is set. */
  postalAddress?: string | null;
  /** One-click unsubscribe from the newsletter (marketing mail, or mail to a subscriber). */
  unsubscribeUrl?: string | null;
  /** Where the person changes their email preferences. */
  preferencesUrl?: string | null;
}

export interface HeroPill {
  label: string;
}

export interface HeroArt {
  /** Path under the asset origin, such as `/email/dispatch.gif`. */
  path: string;
  width: number;
  height: number;
  alt: string;
  href: string;
}

export interface LayoutInput {
  subject: string;
  /** The inbox preview line. */
  preheader: string;
  /** A short label above the headline, such as "Welcome" or "Security". */
  eyebrow: string;
  /** Amber mono line at the masthead's top right, such as "Dispatch · Nov 2026". */
  meta?: string;
  title: string;
  lede?: string;
  /** Shows Otto beside the headline. */
  mascot?: boolean;
  /** Pills with coloured dots under the headline, as on the sign-up screen. */
  pills?: readonly HeroPill[];
  /** An image at the foot of the masthead (the newsletter's live card). */
  art?: HeroArt;
  body: readonly Part[];
  /** Origin that serves `/email/*` (the Desk). */
  assetOrigin: string;
  footer: Footer;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Extra headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
}

/** Web fonts, in their own block: a client that drops `@font-face` keeps the other styles. */
function fontStyle(origin: string): string {
  return `@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:300 700;font-display:swap;src:url('${origin}/email/fonts/space-grotesk.woff2') format('woff2');}
@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url('${origin}/email/fonts/ibm-plex-mono-500.woff2') format('woff2');}`;
}

const STYLE = `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;}
@media only screen and (max-width:620px){
.k-shell{padding:12px 8px!important;}
.k-px{padding-left:22px!important;padding-right:22px!important;}
.k-px-sm{padding-left:18px!important;padding-right:18px!important;}
.k-title{font-size:32px!important;line-height:36px!important;}
.k-otto{width:56px!important;height:56px!important;}
.k-fluid{width:100%!important;height:auto!important;}
.k-row{display:block!important;width:auto!important;white-space:normal!important;}
.k-row-l{padding-bottom:2px!important;}
.k-row + .k-row{border-top:0!important;padding-top:0!important;}
.k-col{display:block!important;width:auto!important;}
.k-gap{display:block!important;width:auto!important;height:12px!important;}
}
@media (prefers-color-scheme:dark){
.k-page{background-color:${palette.darkPage}!important;}
.k-card{background-color:${palette.darkCard}!important;}
.k-cell{background-color:${palette.darkCell}!important;border-color:${palette.darkBorder}!important;}
.k-text{color:${palette.darkText}!important;}
.k-muted{color:${palette.darkMuted}!important;}
.k-link{color:${palette.darkLink}!important;}
.k-row,.k-rule{border-color:${palette.darkBorder}!important;}
}
[data-ogsc] .k-page{background-color:${palette.darkPage}!important;}
[data-ogsc] .k-card{background-color:${palette.darkCard}!important;}
[data-ogsc] .k-cell{background-color:${palette.darkCell}!important;}
[data-ogsc] .k-text{color:${palette.darkText}!important;}
[data-ogsc] .k-muted{color:${palette.darkMuted}!important;}
[data-ogsc] .k-link{color:${palette.darkLink}!important;}
`;

function footerParts(footer: Footer): Part {
  const legal: EmailLink[] = [
    { label: 'License', href: legalLinks.license },
    { label: 'Additional terms', href: legalLinks.additionalTerms },
    { label: 'Trademarks', href: legalLinks.trademarks },
    { label: 'Source code', href: legalLinks.source },
  ];
  const small = `font-family:${FONT};font-size:12px;line-height:20px;color:${palette.muted};`;
  const lines: string[] = [
    `<p class="k-muted" style="margin:0 0 10px 0;${small}">${escapeHtml(footer.reason)}</p>`,
  ];
  const textLines: string[] = [footer.reason];
  if (footer.unsubscribeUrl || footer.preferencesUrl) {
    const items: EmailLink[] = [];
    if (footer.unsubscribeUrl) items.push({ label: 'Unsubscribe', href: footer.unsubscribeUrl });
    if (footer.preferencesUrl)
      items.push({ label: 'Email preferences', href: footer.preferencesUrl });
    lines.push(
      `<p class="k-muted" style="margin:0 0 10px 0;${small}">${items.map((i) => link(i.label, i.href, palette.muted)).join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;')}</p>`,
    );
    for (const item of items) textLines.push(`${item.label}: ${item.href}`);
  }
  if (footer.postalAddress) {
    lines.push(
      `<p class="k-muted" style="margin:0 0 10px 0;${small}">${escapeHtml(footer.postalAddress)}</p>`,
    );
    textLines.push(footer.postalAddress);
  }
  // The attribution and legal notices (ADDITIONAL-TERMS.md): visible, readable, never removed.
  lines.push(
    `<p class="k-muted" style="margin:14px 0 6px 0;font-family:${FONT};font-size:13px;line-height:20px;font-weight:600;color:${palette.text};"><a href="${safeHref(BRAND_URL)}" class="k-text" style="color:${palette.text};text-decoration:none;">${escapeHtml(POWERED_BY)}</a></p>`,
    `<p class="k-muted" style="margin:0 0 4px 0;${small}">${legal.map((i) => link(i.label, i.href, palette.muted)).join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;')}</p>`,
    `<p class="k-muted" style="margin:0;${small}">${escapeHtml(COPYRIGHT_NOTICE)}</p>`,
  );
  textLines.push(
    '',
    `${POWERED_BY}: ${BRAND_URL}`,
    legal.map((i) => `${i.label}: ${i.href}`).join('\n'),
    COPYRIGHT_NOTICE,
  );
  return { html: lines.join('\n'), text: textLines.join('\n') };
}

/** The two-tone rule under the site's hero headline: a short light line, then a long mint one. */
const RULE = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;"><tr>
<td width="56" style="width:56px;height:2px;background-color:${palette.inkText};font-size:0;line-height:0;">&nbsp;</td>
<td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>
<td width="200" style="width:200px;height:2px;background-color:${palette.mint};font-size:0;line-height:0;">&nbsp;</td>
</tr></table>`;

function pillsRow(pills: readonly HeroPill[]): string {
  const cells = pills
    .map(
      (p, index) =>
        `<td style="padding:0 8px 8px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td style="border:1px solid ${palette.inkLine};border-radius:999px;padding:7px 13px;font-family:${FONT};font-size:13px;line-height:16px;color:${palette.inkText};white-space:nowrap;"><span style="color:${tile(index).dot};font-size:11px;">&#9679;</span>&nbsp;&nbsp;${escapeHtml(p.label)}</td></tr></table></td>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;"><tr>${cells}</tr></table>`;
}

/** Builds the whole message: masthead, body blocks and footer, as HTML and plain text. */
export function renderLayout(input: LayoutInput): { html: string; text: string } {
  const origin = input.assetOrigin.replace(/\/+$/, '');
  const wordmark = `${origin}/email/knoqra-wordmark.png`;
  const otto = `${origin}/email/otto.png`;
  const footer = footerParts(input.footer);
  const titleBlock = `<p style="margin:0 0 12px 0;font-family:${MONO};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.1em;text-transform:uppercase;color:${palette.accent};">${escapeHtml(input.eyebrow)}</p>
<h1 class="k-title" style="margin:0;font-family:${DISPLAY};font-size:40px;line-height:43px;font-weight:400;letter-spacing:-0.035em;color:${palette.inkText};">${escapeHtml(input.title)}</h1>
${input.lede ? `<p style="margin:14px 0 0 0;font-family:${FONT};font-size:16px;line-height:25px;color:${palette.inkSoft};">${escapeHtml(input.lede)}</p>` : ''}`;
  const hero = input.mascot
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="top">${titleBlock}</td>
<td valign="top" align="right" style="padding-left:16px;width:80px;"><img src="${escapeHtml(otto)}" width="80" height="80" alt="Otto, the KNOQRA otter" class="k-otto" style="display:block;width:80px;height:80px;border-radius:999px;"></td>
</tr></table>`
    : titleBlock;
  const art = input.art
    ? `${spacer(26)}<a href="${safeHref(input.art.href)}" style="text-decoration:none;"><img src="${escapeHtml(`${origin}${input.art.path}`)}" width="${input.art.width}" height="${input.art.height}" alt="${escapeHtml(input.art.alt)}" class="k-fluid" style="display:block;width:100%;max-width:${input.art.width}px;height:auto;border:0;color:${palette.inkSoft};font-family:${FONT};font-size:14px;"></a>`
    : '';

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,a,h1,h2,span{font-family:Arial,Helvetica,sans-serif!important;}</style><![endif]-->
<!--[if !mso]><!--><style>${fontStyle(origin)}</style><!--<![endif]-->
<style>${STYLE}</style>
</head>
<body class="k-page" style="margin:0;padding:0;background-color:${palette.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${palette.page};">${escapeHtml(input.preheader)}${'&#8199;&#65279;&#847;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="k-page" style="background-color:${palette.page};">
<tr><td align="center" class="k-shell" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;">
<tr><td class="k-px" style="background-color:${palette.ink};background-image:${HERO_GLOW};border-radius:24px 24px 0 0;padding:28px 40px 36px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle"><a href="${safeHref(BRAND_URL)}" style="text-decoration:none;"><img src="${escapeHtml(wordmark)}" width="143" height="25" alt="${escapeHtml(BRAND_NAME)}" style="display:block;width:143px;height:25px;color:${palette.inkText};font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:0.08em;"></a></td>
${input.meta ? `<td valign="middle" align="right" style="font-family:${MONO};font-size:11px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${palette.amber};">${escapeHtml(input.meta)}</td>` : ''}
</tr></table>
${spacer(34)}
${hero}
${RULE}
${input.pills && input.pills.length > 0 ? pillsRow(input.pills) : ''}
${art}
</td></tr>
<tr><td style="background-color:${palette.accent};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
<tr><td class="k-card k-px" style="background-color:${palette.card};border-radius:0 0 24px 24px;padding:36px 40px 28px 40px;">
${input.body.map((part) => part.html).join('\n')}
</td></tr>
<tr><td class="k-px" style="padding:28px 40px 8px 40px;">
${footer.html}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

  const text = [
    input.meta ? `${BRAND_NAME} · ${input.meta.toUpperCase()}` : BRAND_NAME,
    '',
    input.title,
    input.lede ?? '',
    '',
    input.body
      .map((part) => part.text)
      .filter((value) => value !== '')
      .join('\n\n'),
    '',
    '--',
    footer.text,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { html, text: `${text}\n` };
}

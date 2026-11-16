import { logger } from '../lib/logger';
import type { PostSummary } from './layout';

/**
 * The latest posts of a blog, read from its RSS 2.0 feed (the marketing site builds one at
 * `/rss.xml`). Mail must never wait long on it or fail because of it: a slow, missing or broken
 * feed gives no posts and the email leaves the section out.
 */

export interface BlogFeed {
  /** The blog's home page (the channel link), when the feed names one. */
  home: string | null;
  posts: PostSummary[];
}

const EMPTY: BlogFeed = { home: null, posts: [] };
const FEED_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_FEED_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 180;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const raw = cdata ? (cdata[1] ?? '') : value;
  const text = raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
  // Descriptions may carry markup: mail shows them as plain text.
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decode(match[1] ?? '') : null;
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function shorten(value: string): string {
  if (value.length <= MAX_DESCRIPTION) return value;
  const cut = value.slice(0, MAX_DESCRIPTION);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_DESCRIPTION - 20)).trimEnd()}…`;
}

/** Parses an RSS 2.0 document: newest first, items without a title or an http(s) link skipped. */
export function parseFeed(xml: string, limit = 3): BlogFeed {
  const channel = xml.replace(/<item[\s>][\s\S]*?<\/item>/gi, '');
  const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)]
    .map((match): PostSummary | null => {
      const body = match[1] ?? '';
      const title = tag(body, 'title');
      const url = httpUrl(tag(body, 'link'));
      if (!title || !url) return null;
      const pubDate = tag(body, 'pubDate');
      const published = pubDate ? new Date(pubDate) : null;
      const tags = [...body.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
        .map((m) => decode(m[1] ?? ''))
        .filter(Boolean);
      return {
        title,
        url,
        tags,
        description: shorten(tag(body, 'description') ?? ''),
        published: published && !Number.isNaN(published.getTime()) ? published : null,
      };
    })
    .filter((post): post is PostSummary => post !== null)
    .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0));
  return { home: httpUrl(tag(channel, 'link')), posts: items.slice(0, limit) };
}

let cache: { url: string; at: number; feed: BlogFeed } | null = null;

/** Forgets the cached feed (tests). */
export function resetFeedCache(): void {
  cache = null;
}

/**
 * The newest posts of the feed at `url`, remembered per isolate for an hour. Never throws: any
 * failure is logged and gives an empty feed.
 */
export async function latestPosts(
  url: string | undefined,
  options: { fetch?: typeof fetch; now?: number; limit?: number } = {},
): Promise<BlogFeed> {
  const feedUrl = httpUrl(url?.trim() || null);
  if (!feedUrl) return EMPTY;
  const now = options.now ?? Date.now();
  if (cache && cache.url === feedUrl && now - cache.at < CACHE_TTL_MS) return cache.feed;
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(feedUrl, {
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      logger.warn('email.blog_feed_failed', { status: response.status });
      return EMPTY;
    }
    const xml = (await response.text()).slice(0, MAX_FEED_BYTES);
    const feed = parseFeed(xml, options.limit ?? 3);
    cache = { url: feedUrl, at: now, feed };
    return feed;
  } catch (error) {
    logger.warn('email.blog_feed_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return EMPTY;
  }
}

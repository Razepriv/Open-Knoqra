import { type Database, organization, phoneNumber, withTenant } from '@knoqra/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from '../env';
import type { EmailSender } from '../lib/email';
import { logger } from '../lib/logger';
import { editionOf } from '../license/edition';
import { latestPosts } from './blog-feed';
import { type EmailContext, welcomeEmail } from './templates';
import { unsubscribeUrl } from './unsubscribe';

/** The sending deployment, as the templates see it. */
export function emailContext(
  env: Pick<Env, 'BETTER_AUTH_URL' | 'EMAIL_POSTAL_ADDRESS' | 'EMAIL_REPLY_TO'>,
): EmailContext {
  return {
    deskOrigin: env.BETTER_AUTH_URL,
    postalAddress: env.EMAIL_POSTAL_ADDRESS?.trim() || null,
    repliesWelcome: Boolean(env.EMAIL_REPLY_TO?.trim()),
  };
}

/** `+14155550123` as `+1 415 555 0123`; other numbers stay as stored. */
export function formatNumber(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `+1 ${us[1]} ${us[2]} ${us[3]}` : e164;
}

export interface NewUser {
  id: string;
  name: string;
  email: string;
}

export interface WelcomeFacts {
  workspaceName: string;
  plan: string | null;
  number: string | null;
}

/**
 * Reads what the welcome email shows about the new workspace. Runs during the sign-up request:
 * the request's database handle is closed once the response is sent.
 */
export async function welcomeFacts(
  env: Env,
  db: Database,
  organizationId: string,
): Promise<WelcomeFacts> {
  return withTenant(db, organizationId, async (tx) => {
    const [org] = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1);
    const [number] = await tx
      .select({ e164: phoneNumber.e164 })
      .from(phoneNumber)
      .where(and(eq(phoneNumber.organizationId, organizationId), eq(phoneNumber.status, 'active')))
      .orderBy(asc(phoneNumber.createdAt))
      .limit(1);
    let plan: string | null = null;
    for (const extension of env.EXTENSIONS ?? []) {
      if (!extension.planName) continue;
      plan = await extension.planName(tx);
      break;
    }
    if (plan === null && editionOf(env) === 'selfhost') plan = 'Self-hosted';
    return {
      workspaceName: org?.name ?? 'Your workspace',
      plan,
      number: number ? formatNumber(number.e164) : null,
    };
  });
}

/**
 * Builds and sends the welcome email. Meant for the background (`waitUntil`): it fetches the blog
 * feed, and never throws.
 */
export async function sendWelcomeEmail(
  env: Env,
  email: EmailSender,
  user: NewUser,
  facts: WelcomeFacts,
  newsletter: boolean,
  options: { fetch?: typeof fetch } = {},
): Promise<void> {
  try {
    const blog = await latestPosts(env.BLOG_FEED_URL, options);
    const message = welcomeEmail(emailContext(env), {
      name: user.name,
      email: user.email,
      ...facts,
      blog,
      unsubscribeUrl: newsletter
        ? await unsubscribeUrl(env.BETTER_AUTH_URL, env.BETTER_AUTH_SECRET, user.id)
        : null,
    });
    await email.send({ to: user.email, ...message });
  } catch (error) {
    logger.error('email.welcome_failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

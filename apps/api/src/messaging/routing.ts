import type { MessagingChannel } from '@knoqra/core';
import { channelRoute, type Database, MESSAGE_PROVIDERS, type MessageProvider } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';

export interface ResolvedRoute {
  orgId: string;
  connectionId: string;
}

const isProvider = (value: string): value is MessageProvider =>
  (MESSAGE_PROVIDERS as readonly string[]).includes(value);

/**
 * Maps a provider address to its organization. Runs without tenant context: `channel_route` is
 * readable by everyone through the `route_lookup` policy (it holds no secrets).
 */
export async function resolveRoute(
  db: Database,
  provider: string,
  channel: MessagingChannel,
  address: string,
): Promise<ResolvedRoute | null> {
  if (!isProvider(provider)) return null;
  const [row] = await db
    .select({ orgId: channelRoute.organizationId, connectionId: channelRoute.connectionId })
    .from(channelRoute)
    .where(
      and(
        eq(channelRoute.provider, provider),
        eq(channelRoute.channel, channel),
        eq(channelRoute.address, address),
      ),
    )
    .limit(1);
  return row ?? null;
}

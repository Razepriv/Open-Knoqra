import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';

export type AppNotification = components['schemas']['Notification'];

export const notificationsKey = ['notifications'] as const;
const REFETCH_MS = 60_000;

/** The latest notifications and the unread count. Refetches every minute and on window focus. */
export function useNotifications() {
  return useQuery({
    queryKey: [...notificationsKey, 'feed'],
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: true,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/notifications', { params: { query: { limit: 20 } }, signal }),
        'Could not load your notifications.',
      ),
  });
}

export function useMarkRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      throwIfFailed(
        await api.POST('/api/v1/notifications/{id}/read', { params: { path: { id } } }),
        'Could not mark this as read.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationsKey }),
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      throwIfFailed(
        await api.POST('/api/v1/notifications/read-all'),
        'Could not mark these as read.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: notificationsKey }),
  });
}

/** The badge text: the count up to 9, then "9+". */
export function badgeLabel(unread: number): string {
  return unread > 9 ? '9+' : String(unread);
}

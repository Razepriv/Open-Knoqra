import type { components } from '@knoqra/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';
import type { Channel, ChannelPermission, TimelineEvent } from './contact360';
import { type Contact, contactKey, contactsKey } from './contacts';
import { OFFLINE_FAILS_FAST } from './query-state';

export type TimelineFilter = 'all' | 'calls' | 'messages' | 'notes_consent';
export type PermissionStatus = 'granted' | 'revoked' | 'opted_out';

export const timelineRoot = ['timeline'] as const;
export const timelineKey = (id: string) => [...timelineRoot, id] as const;
export const permissionsKey = (id: string) => ['permissions', id] as const;
export const duplicatesRoot = ['duplicates'] as const;
export const duplicatesKey = (id: string) => [...duplicatesRoot, id] as const;

export function useContact(id: string) {
  return useQuery({
    queryKey: contactKey(id),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts/{id}', { params: { path: { id } }, signal }),
        'Could not load this contact.',
      ),
    // A missing contact will not appear by retrying.
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 1,
  });
}

export function useTimeline(id: string, kind: TimelineFilter) {
  return useInfiniteQuery({
    queryKey: [...timelineKey(id), kind],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts/{id}/timeline', {
          params: { path: { id }, query: { kind, ...(pageParam ? { cursor: pageParam } : {}) } },
          signal,
        }),
        'Could not load the timeline.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

const MERGE_HISTORY_PAGES = 5;
const MERGE_HISTORY_PAGE_SIZE = 200;

export interface MergeHistory {
  merges: TimelineEvent[];
  /** True when the scan stopped at its cap with older events left unread. */
  capped: boolean;
}

/**
 * "Merged X into this contact" events, for the provenance block. For M1 this is a client scan: the
 * API has no merge filter or `mergedFrom` field (a server field is a follow-up). A merge is
 * recognised as a `system` timeline event whose `refType` is `contact`, which is how the merge
 * endpoint records it. The scan reads up to five pages of 200 events and reports when it stopped
 * early. It runs only when `enabled`, so the cost is paid when the block is opened.
 */
export function useMergeHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['timeline-merges', id],
    enabled,
    queryFn: async ({ signal }): Promise<MergeHistory> => {
      const merges: TimelineEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MERGE_HISTORY_PAGES; page += 1) {
        const result = throwIfFailed(
          await api.GET('/api/v1/contacts/{id}/timeline', {
            params: {
              path: { id },
              query: {
                kind: 'all',
                limit: MERGE_HISTORY_PAGE_SIZE,
                ...(cursor ? { cursor } : {}),
              },
            },
            signal,
          }),
          'Could not load the timeline.',
        );
        merges.push(...result.items.filter((e) => e.kind === 'system' && e.refType === 'contact'));
        if (!result.nextCursor) return { merges, capped: false };
        cursor = result.nextCursor;
      }
      return { merges, capped: true };
    },
  });
}

export function useAddNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (body: string) =>
      throwIfFailed(
        await api.POST('/api/v1/contacts/{id}/notes', { params: { path: { id } }, body: { body } }),
        'Could not save the note.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: timelineKey(id) }),
  });
}

export function usePermissions(id: string) {
  return useQuery({
    queryKey: permissionsKey(id),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts/{id}/permissions', { params: { path: { id } }, signal }),
        'Could not load permissions.',
      ),
    // The contact page waits for this query too, so a missing contact must not wait on a retry.
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 1,
  });
}

function usePermissionRefresh(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: permissionsKey(id) }),
      queryClient.invalidateQueries({ queryKey: timelineKey(id) }),
    ]);
}

export function useSetPermission(id: string) {
  const refresh = usePermissionRefresh(id);
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (input: {
      channel: Channel;
      status: PermissionStatus;
      evidence?: string;
      /** Required by the API to grant a channel that is do not contact. */
      reason?: string;
    }) =>
      throwIfFailed(
        await api.PUT('/api/v1/contacts/{id}/permissions/{channel}', {
          params: { path: { id, channel: input.channel } },
          body: {
            status: input.status,
            ...(input.evidence ? { evidence: input.evidence } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          },
        }),
        'Could not save this change.',
      ),
    onSuccess: refresh,
  });
}

export function useDoNotContact(id: string) {
  const refresh = usePermissionRefresh(id);
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (evidence?: string) =>
      throwIfFailed(
        await api.POST('/api/v1/contacts/{id}/do-not-contact', {
          params: { path: { id } },
          body: evidence ? { evidence } : {},
        }),
        'Could not save this change.',
      ),
    onSuccess: refresh,
  });
}

export function permissionFor(
  channels: readonly ChannelPermission[] | undefined,
  channel: Channel,
): ChannelPermission | undefined {
  return channels?.find((p) => p.channel === channel);
}

export function useDuplicates(id: string) {
  return useQuery({
    queryKey: duplicatesKey(id),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts/{id}/duplicates', { params: { path: { id } }, signal }),
        'Could not check for duplicates.',
      ),
  });
}

export function useDismissDuplicate(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (otherId: string) => {
      const result = await api.POST('/api/v1/contacts/{id}/duplicates/{otherId}/dismiss', {
        params: { path: { id, otherId } },
      });
      // 204 has no body; anything else is an error envelope that throwIfFailed turns into an ApiError.
      if (!result.response.ok) throwIfFailed(result, 'Could not dismiss this.');
    },
    onSuccess: (_data, otherId) =>
      // The suggestion is symmetric: the other contact must stop offering it too.
      Promise.all([
        queryClient.invalidateQueries({ queryKey: duplicatesKey(id) }),
        queryClient.invalidateQueries({ queryKey: duplicatesKey(otherId) }),
      ]),
  });
}

/** Merges `sourceId` into this contact. Everything about both is stale afterwards. */
export function useMergeContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (sourceId: string) =>
      throwIfFailed(
        await api.POST('/api/v1/contacts/{id}/merge', {
          params: { path: { id } },
          body: { sourceId },
        }),
        'Could not merge these contacts.',
      ),
    onSuccess: (_merged, sourceId) => {
      // The source is now archived and merged: drop everything cached about it so it cannot be
      // shown as a live, editable contact when someone navigates back to it.
      queryClient.removeQueries({ queryKey: contactKey(sourceId) });
      queryClient.removeQueries({ queryKey: timelineKey(sourceId) });
      queryClient.removeQueries({ queryKey: permissionsKey(sourceId) });
      queryClient.removeQueries({ queryKey: duplicatesKey(sourceId) });
      queryClient.removeQueries({ queryKey: ['timeline-merges', sourceId] });
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: contactsKey }),
        queryClient.invalidateQueries({ queryKey: contactKey(id) }),
        queryClient.invalidateQueries({ queryKey: timelineKey(id) }),
        queryClient.invalidateQueries({ queryKey: ['timeline-merges', id] }),
        queryClient.invalidateQueries({ queryKey: permissionsKey(id) }),
        queryClient.invalidateQueries({ queryKey: duplicatesKey(id) }),
      ]);
    },
  });
}

export type UpdateContactBody = components['schemas']['UpdateContact'];

export function useUpdateContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (body: UpdateContactBody) =>
      throwIfFailed(
        await api.PATCH('/api/v1/contacts/{id}', { params: { path: { id } }, body }),
        'Could not save this contact.',
      ),
    onSuccess: (updated: Contact) => {
      queryClient.setQueryData(contactKey(id), updated);
      // A name, email or archive change alters which contacts look alike, for every contact.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: contactsKey }),
        queryClient.invalidateQueries({ queryKey: timelineKey(id) }),
        queryClient.invalidateQueries({ queryKey: duplicatesRoot }),
      ]);
    },
  });
}

function useArchiveToggle(id: string, action: 'archive' | 'restore') {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async () => {
      const path = { params: { path: { id } } };
      const result =
        action === 'archive'
          ? await api.POST('/api/v1/contacts/{id}/archive', path)
          : await api.POST('/api/v1/contacts/{id}/restore', path);
      return throwIfFailed(result, 'Could not update this contact.');
    },
    onSuccess: (updated: Contact) => {
      queryClient.setQueryData(contactKey(id), updated);
      // A name, email or archive change alters which contacts look alike, for every contact.
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: contactsKey }),
        queryClient.invalidateQueries({ queryKey: timelineKey(id) }),
        queryClient.invalidateQueries({ queryKey: duplicatesRoot }),
      ]);
    },
  });
}

export const useArchiveContact = (id: string) => useArchiveToggle(id, 'archive');
export const useRestoreContact = (id: string) => useArchiveToggle(id, 'restore');

import type { components } from '@knoqra/api-client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError, api, throwIfFailed } from './api';

export type Conversation = components['schemas']['Conversation'];
export type ConversationDetail = components['schemas']['ConversationDetail'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type Message = components['schemas']['Message'];
export type MessageTemplate = components['schemas']['MessageTemplate'];
export type MessagingSender = components['schemas']['MessagingSender'];
export type InboxFilter = 'all' | 'unread' | 'sms' | 'whatsapp';
export type RegistrationStatus = components['schemas']['UpdateSandbox']['sms'];

export const conversationsRoot = ['conversations'] as const;
export const conversationKey = (id: string) => ['conversation', id] as const;
export const threadKey = (id: string) => ['thread', id] as const;
export const sendersKey = ['messaging-senders'] as const;
export const templatesKey = (channel: 'sms' | 'whatsapp' | undefined) =>
  ['messaging-templates', channel ?? 'all'] as const;

const CONVERSATIONS_POLL_MS = 5000;
const CONVERSATION_POLL_MS = 4000;
const THREAD_POLL_MS = 3000;

export function useConversations(filter: InboxFilter, q: string) {
  return useInfiniteQuery({
    queryKey: [...conversationsRoot, filter, q],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/conversations', {
          params: {
            query: {
              filter,
              ...(q ? { q } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
          signal,
        }),
        'Could not load your conversations.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: CONVERSATIONS_POLL_MS,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: conversationKey(id),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/conversations/{id}', { params: { path: { id } }, signal }),
        'Could not load this conversation.',
      ),
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 1,
    refetchInterval: CONVERSATION_POLL_MS,
  });
}

export function useThreadItems(id: string) {
  return useInfiniteQuery({
    queryKey: threadKey(id),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/conversations/{id}/items', {
          params: { path: { id }, query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
        'Could not load the messages.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: THREAD_POLL_MS,
  });
}

export function useSenders() {
  return useQuery({
    queryKey: sendersKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/messaging/senders', { signal }),
        'Could not load your senders.',
      ),
  });
}

export function useTemplates(channel?: 'sms' | 'whatsapp') {
  return useQuery({
    queryKey: templatesKey(channel),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/messaging/templates', {
          params: { query: channel ? { channel } : {} },
          signal,
        }),
        'Could not load templates.',
      ),
  });
}

function useRefreshConversation(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: conversationsRoot }),
      queryClient.invalidateQueries({ queryKey: conversationKey(id) }),
      queryClient.invalidateQueries({ queryKey: threadKey(id) }),
    ]);
}

export interface SendInput {
  body?: string;
  templateId?: string;
}

const SEND_FALLBACK_COPY = 'We could not send this message. Try again.';
const SEND_RATE_LIMITED_COPY = 'Too many messages at once. Wait a minute and try again.';

/**
 * Our wording for a failed send. A 422 refusal carries the server's own explanation (paused,
 * blocked, template required); a rate limit asks the sender to wait; anything else is generic.
 */
export function sendErrorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return SEND_FALLBACK_COPY;
  if (error.status === 422) return error.message;
  // Not enough credit, or past the spend cap: the server's copy says which.
  if (error.status === 402 && error.code === 'spend_blocked') return error.message;
  if (error.code === 'rate_limited') return SEND_RATE_LIMITED_COPY;
  return SEND_FALLBACK_COPY;
}

/**
 * Sends a message. One logical submit keeps one `clientMessageId`, so a retry after a failure
 * reuses it and the API can drop a duplicate; the id is renewed only after a success.
 */
export function useSendMessage(id: string) {
  const refresh = useRefreshConversation(id);
  const pending = useRef<{ key: string; clientMessageId: string } | null>(null);
  return useMutation({
    mutationFn: async (input: SendInput) => {
      const key = JSON.stringify([input.body ?? null, input.templateId ?? null]);
      if (pending.current?.key !== key) {
        pending.current = { key, clientMessageId: crypto.randomUUID() };
      }
      const { clientMessageId } = pending.current;
      const message = throwIfFailed(
        await api.POST('/api/v1/conversations/{id}/messages', {
          params: { path: { id } },
          body: {
            clientMessageId,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.templateId ? { templateId: input.templateId } : {}),
          },
        }),
        'Could not send this message.',
      );
      pending.current = null;
      return message;
    },
    onSettled: refresh,
  });
}

/** An internal note on the thread (named apart from the contact 360 `useAddNote`). */
export function useAddThreadNote(id: string) {
  const refresh = useRefreshConversation(id);
  return useMutation({
    mutationFn: async (body: string) =>
      throwIfFailed(
        await api.POST('/api/v1/conversations/{id}/notes', {
          params: { path: { id } },
          body: { body },
        }),
        'Could not save the note.',
      ),
    onSuccess: refresh,
  });
}

export function useMarkRead(id: string) {
  const refresh = useRefreshConversation(id);
  return useMutation({
    mutationFn: async () => {
      const result = await api.POST('/api/v1/conversations/{id}/read', {
        params: { path: { id } },
      });
      if (!result.response.ok) {
        throw new ApiError(result.response.status, 'Could not mark this conversation as read.');
      }
    },
    onSuccess: refresh,
  });
}

export function useOpenConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contactId: string; channel: 'sms' | 'whatsapp' }) =>
      throwIfFailed(
        await api.POST('/api/v1/conversations', { body: input }),
        'Could not open this conversation.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: conversationsRoot }),
  });
}

export function useSetSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { sms: RegistrationStatus; whatsapp: RegistrationStatus }) =>
      throwIfFailed(
        await api.PUT('/api/v1/messaging/sandbox', { body }),
        'Could not set up the sandbox sender.',
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sendersKey }),
        queryClient.invalidateQueries({ queryKey: conversationsRoot }),
      ]),
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: components['schemas']['CreateMessageTemplate']) =>
      throwIfFailed(
        await api.POST('/api/v1/messaging/templates', { body }),
        'Could not save this template.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messaging-templates'] }),
  });
}

export function useArchiveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      throwIfFailed(
        await api.POST('/api/v1/messaging/templates/{id}/archive', { params: { path: { id } } }),
        'Could not archive this template.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messaging-templates'] }),
  });
}

/** Owners and admins: the Telnyx number becomes the channel's live sender, with its registration. */
export function useSetLiveSender() {
  const queryClient = useQueryClient();
  return useMutation({
    // SMS sends no status: it follows the synced number (ruling AQ). WhatsApp sends the owner's (AR).
    mutationFn: async (input: {
      channel: 'sms' | 'whatsapp';
      registrationStatus?: RegistrationStatus;
    }) =>
      throwIfFailed(
        await api.PUT('/api/v1/messaging/senders/{channel}', {
          params: { path: { channel: input.channel } },
          body:
            input.channel === 'whatsapp' && input.registrationStatus
              ? { registrationStatus: input.registrationStatus }
              : {},
        }),
        'Could not save the live sender.',
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sendersKey }),
        queryClient.invalidateQueries({ queryKey: conversationsRoot }),
        queryClient.invalidateQueries({ queryKey: ['conversation'] }),
      ]),
  });
}

/** Owners and admins: records that Meta approved a pending WhatsApp template. */
export function useApproveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      throwIfFailed(
        await api.POST('/api/v1/messaging/templates/{id}/approve', { params: { path: { id } } }),
        'Could not mark this template approved.',
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['messaging-templates'] }),
  });
}

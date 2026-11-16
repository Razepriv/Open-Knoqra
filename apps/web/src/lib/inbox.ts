import type { components } from '@knoqra/api-client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, meQueryKey, networkAwareFetch, throwIfFailed } from './api';
import {
  type Attachment,
  failOptimistic,
  optimisticMessage,
  removeOptimistic,
  type ThreadData,
  updateThreadMessage,
  upsertThreadMessage,
  withOwnReaction,
} from './inbox-cache';
import { pollWhileOffline, useRealtimeStatus } from './realtime-status';

export type Conversation = components['schemas']['Conversation'];
export type ConversationDetail = components['schemas']['ConversationDetail'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type Message = components['schemas']['Message'];
export type MessageTemplate = components['schemas']['MessageTemplate'];
export type MessagingSender = components['schemas']['MessagingSender'];
export type InboxFilter = 'all' | 'unread' | 'sms' | 'whatsapp';
export type RegistrationStatus = components['schemas']['UpdateSandbox']['sms'];
export type MessagingChannels = components['schemas']['MessagingChannels'];
export type ChannelStatus = components['schemas']['ChannelStatus'];
export type SmsRegistrationRequest = components['schemas']['SmsRegistrationRequest'];
export type { Attachment } from './inbox-cache';

export const conversationsRoot = ['conversations'] as const;
export const conversationKey = (id: string) => ['conversation', id] as const;
export const threadKey = (id: string) => ['thread', id] as const;
export const sendersKey = ['messaging-senders'] as const;
export const templatesKey = (channel: 'sms' | 'whatsapp' | undefined) =>
  ['messaging-templates', channel ?? 'all'] as const;
export const channelsKey = ['messaging-channels'] as const;

export function useConversations(filter: InboxFilter, q: string) {
  // Realtime drives the list; the slow poll only runs while the socket is down.
  const refetchInterval = pollWhileOffline(useRealtimeStatus());
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
    refetchInterval,
  });
}

export function useConversation(id: string) {
  const refetchInterval = pollWhileOffline(useRealtimeStatus());
  return useQuery({
    queryKey: conversationKey(id),
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/conversations/{id}', { params: { path: { id } }, signal }),
        'Could not load this conversation.',
      ),
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 1,
    refetchInterval,
  });
}

export function useThreadItems(id: string) {
  const refetchInterval = pollWhileOffline(useRealtimeStatus());
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
    refetchInterval,
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
  /** A draft file uploaded to this conversation (WhatsApp). */
  attachment?: Attachment;
  /** An inbound message to quote. */
  replyTo?: Message;
}

/** One send: the input plus the id that makes a retry idempotent. */
export interface SendVariables extends SendInput {
  clientMessageId: string;
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

/** Sends waiting for a retry, by clientMessageId: a failed bubble's Retry sends exactly this again. */
const unsent = new Map<string, SendVariables>();
export const unsentSend = (clientMessageId: string): SendVariables | undefined =>
  unsent.get(clientMessageId);

function signedInUserId(queryClient: ReturnType<typeof useQueryClient>): string | null {
  const me = queryClient.getQueryData<{ user?: { id?: unknown } }>(meQueryKey);
  return typeof me?.user?.id === 'string' ? me.user.id : null;
}

/**
 * Sends a message, optimistically: the message shows in the thread at once as "Sending…", then the
 * server's row (and realtime) moves it to sent, delivered, read or failed. A send that never reached
 * the server stays in the thread as failed, with Retry (same clientMessageId, so the API drops a
 * duplicate). Templates are rendered by the server, so they are not shown before it answers.
 */
export function useSendMessage(id: string, channel: Conversation['channel']) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendVariables) =>
      throwIfFailed(
        await api.POST('/api/v1/conversations/{id}/messages', {
          params: { path: { id } },
          body: {
            clientMessageId: input.clientMessageId,
            ...(input.body !== undefined && input.body !== '' ? { body: input.body } : {}),
            ...(input.templateId ? { templateId: input.templateId } : {}),
            ...(input.attachment ? { attachmentId: input.attachment.id } : {}),
            ...(input.replyTo ? { replyToMessageId: input.replyTo.id } : {}),
          },
        }),
        'Could not send this message.',
      ),
    onMutate: async (input) => {
      unsent.set(input.clientMessageId, input);
      if (input.templateId) return;
      await queryClient.cancelQueries({ queryKey: threadKey(id) });
      const optimistic = optimisticMessage({
        conversationId: id,
        channel,
        clientMessageId: input.clientMessageId,
        body: input.body,
        attachment: input.attachment,
        replyTo: input.replyTo
          ? {
              id: input.replyTo.id,
              direction: input.replyTo.direction,
              body: input.replyTo.body,
              attachmentKind: input.replyTo.attachments[0]?.kind ?? null,
            }
          : null,
        authorUserId: signedInUserId(queryClient),
        now: new Date(),
      });
      queryClient.setQueryData<ThreadData>(threadKey(id), (data) =>
        upsertThreadMessage(data, optimistic),
      );
    },
    onSuccess: (message, input) => {
      unsent.delete(input.clientMessageId);
      queryClient.setQueryData<ThreadData>(threadKey(id), (data) =>
        upsertThreadMessage(data, message),
      );
      void queryClient.invalidateQueries({ queryKey: conversationsRoot });
    },
    onError: (error, input) => {
      const refused =
        error instanceof ApiError &&
        (error.status === 422 || error.status === 402 || error.status === 404);
      queryClient.setQueryData<ThreadData>(threadKey(id), (data) =>
        // A refusal (paused, blocked, out of credit) is told in the composer, not left as a bubble.
        refused
          ? removeOptimistic(data, input.clientMessageId)
          : failOptimistic(data, input.clientMessageId, sendErrorCopy(error)),
      );
      if (refused) unsent.delete(input.clientMessageId);
    },
  });
}

/** Drops a failed send that never reached the server. */
export function useDiscardUnsent(id: string) {
  const queryClient = useQueryClient();
  return (clientMessageId: string) => {
    unsent.delete(clientMessageId);
    queryClient.setQueryData<ThreadData>(threadKey(id), (data) =>
      removeOptimistic(data, clientMessageId),
    );
  };
}

/** Sets (or, with '', removes) the workspace's reaction, shown at once and confirmed by realtime. */
export function useSetReaction(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { messageId: string; emoji: string }) =>
      throwIfFailed(
        await api.PUT('/api/v1/messages/{id}/reaction', {
          params: { path: { id: input.messageId } },
          body: { emoji: input.emoji },
        }),
        'Could not send the reaction.',
      ),
    onMutate: (input) => {
      queryClient.setQueryData<ThreadData>(threadKey(conversationId), (data) =>
        updateThreadMessage(
          data,
          (m) => m.id === input.messageId,
          (m) => withOwnReaction(m, input.emoji),
        ),
      );
    },
    onSuccess: (message) => {
      queryClient.setQueryData<ThreadData>(threadKey(conversationId), (data) =>
        upsertThreadMessage(data, message),
      );
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: threadKey(conversationId) }),
  });
}

export interface UploadInput {
  file: Blob;
  name?: string;
  voice?: boolean;
  durationMs?: number;
  waveform?: number[];
}

/** Uploads a file to send on a WhatsApp conversation; answers the stored draft. */
export async function uploadAttachment(
  conversationId: string,
  input: UploadInput,
  signal?: AbortSignal,
): Promise<Attachment> {
  const query = new URLSearchParams();
  if (input.name) query.set('name', input.name);
  if (input.voice) query.set('voice', 'true');
  if (input.durationMs !== undefined) query.set('durationMs', String(Math.round(input.durationMs)));
  if (input.waveform?.length) query.set('waveform', input.waveform.join(','));
  const doFetch = networkAwareFetch((...args) => globalThis.fetch(...args));
  const res = await doFetch(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments?${query}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': input.file.type || 'application/octet-stream' },
      body: input.file,
      ...(signal ? { signal } : {}),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    data: Attachment | null;
    error: { code: string; message: string } | null;
  } | null;
  if (!res.ok || !body?.data) {
    throw new ApiError(
      res.status,
      body?.error?.message ?? 'Could not upload this file.',
      body?.error?.code,
    );
  }
  return body.data;
}

export function useChannels() {
  return useQuery({
    queryKey: channelsKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/messaging/channels', { signal }),
        'Could not load your channels.',
      ),
  });
}

function useChannelsMutation<T>(run: (input: T) => Promise<MessagingChannels>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (channels) => {
      queryClient.setQueryData(channelsKey, channels);
      void queryClient.invalidateQueries({ queryKey: sendersKey });
      void queryClient.invalidateQueries({ queryKey: ['conversation'] });
      void queryClient.invalidateQueries({ queryKey: conversationsRoot });
    },
  });
}

export function useRegisterSms() {
  return useChannelsMutation(async (body: SmsRegistrationRequest) =>
    throwIfFailed(
      await api.POST('/api/v1/messaging/sms/registration', { body }),
      'Could not submit the registration.',
    ),
  );
}

export function useVerifySmsCode() {
  return useChannelsMutation(async (pin: string) =>
    throwIfFailed(
      await api.POST('/api/v1/messaging/sms/registration/code', { body: { pin } }),
      'Could not check the code.',
    ),
  );
}

export function useResendSmsCode() {
  return useChannelsMutation(async (_: undefined) =>
    throwIfFailed(
      await api.POST('/api/v1/messaging/sms/registration/code/resend', {}),
      'Could not send a new code.',
    ),
  );
}

export function useRefreshChannels() {
  return useChannelsMutation(async (_: undefined) =>
    throwIfFailed(
      await api.POST('/api/v1/messaging/channels/refresh', {}),
      'Could not check your channels.',
    ),
  );
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await api.POST('/api/v1/conversations/{id}/read', {
        params: { path: { id } },
      });
      if (!result.response.ok) {
        throw new ApiError(result.response.status, 'Could not mark this conversation as read.');
      }
    },
    onSuccess: () => {
      // The detail already shows the thread; only the unread badges change.
      queryClient.setQueryData<ConversationDetail>(conversationKey(id), (cached) =>
        cached ? { ...cached, unreadCount: 0 } : cached,
      );
      void queryClient.invalidateQueries({ queryKey: conversationsRoot });
    },
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

/** Owners and admins: the synced number becomes the channel's live sender; its status is synced. */
export function useSetLiveSender() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { channel: 'sms' | 'whatsapp' }) =>
      throwIfFailed(
        await api.PUT('/api/v1/messaging/senders/{channel}', {
          params: { path: { channel: input.channel } },
          body: {},
        }),
        'Could not save the live sender.',
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sendersKey }),
        queryClient.invalidateQueries({ queryKey: channelsKey }),
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

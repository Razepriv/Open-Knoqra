import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, NetworkError, networkAwareFetch, throwIfFailed } from './api';

export type OttoDraft = components['schemas']['OttoDraft'];
export type OttoConnection = components['schemas']['OttoConnection'];
export type OttoCitation = OttoDraft['citations'][number];
export type OttoChannel = NonNullable<OttoDraft['channel']>;
export type OttoMood = 'idle' | 'listening' | 'thinking' | 'happy';

export interface OttoDraftRequest {
  kind: 'draft' | 'brief';
  contactId: string;
  channel?: OttoChannel;
}

const CONTACT_ID = /^ct_[0-9a-f]{32}$/;
const contactPath = (id: string | null | undefined): string | null =>
  id && CONTACT_ID.test(id) ? `/contacts/${id}` : null;

/**
 * Where a "FROM:" citation leads. Timeline and task citations do not carry their contact, so they
 * point at the contact the draft or brief is about (`draftContactId`); a digest has none, so a
 * task falls back to the task list and a timeline event has no link. Notifications have no page.
 */
export function citationHref(
  citation: Pick<OttoCitation, 'kind' | 'ref'>,
  draftContactId?: string | null,
): string | null {
  switch (citation.kind) {
    case 'contact':
      return contactPath(citation.ref);
    case 'timeline':
      return contactPath(draftContactId);
    case 'task':
      return draftContactId ? contactPath(draftContactId) : '/tasks';
    case 'notification':
      return null;
  }
}

/** The label above every Otto output: what it is and, for a draft, that it was not sent. */
export function ottoEyebrow(draft: Pick<OttoDraft, 'kind' | 'channel'>): string {
  switch (draft.kind) {
    case 'draft':
      return draft.channel
        ? `DRAFT · ${draft.channel.toUpperCase()} · NOT SENT`
        : 'DRAFT · NOT SENT';
    case 'brief':
      return 'BRIEF';
    case 'digest':
      return 'WHAT YOU MISSED';
  }
}

/** Our own wording for a failed Otto request, so no server text reaches the screen. */
export function ottoErrorMessage(error: unknown, earlyAccess = false): string {
  if (error instanceof NetworkError) {
    return 'We could not reach KNOQRA. Check your connection and try again.';
  }
  if (error instanceof ApiError) {
    if (error.code === 'otto_not_connected') return 'Connect Otto to OpenAI in Settings first.';
    if (error.code === 'otto_upgrade_required') {
      return 'Your plan does not include Otto. Upgrade, or connect your own OpenAI key in Settings.';
    }
    if (error.code === 'ai_busy') {
      return `Otto is busy right now${earlyAccess ? ' (early access)' : ''}. Try again in a minute.`;
    }
    if (error.status === 429) return "Otto has reached today's limit.";
    if (error.status === 503) return 'Otto is unavailable right now. Try again in a minute.';
    if (error.status === 404) return 'We could not find that contact.';
    if (error.status === 422) return 'Otto can only work with active contacts.';
  }
  return 'Otto could not answer. Try again.';
}

/** Otto thinks while a request is out, is pleased with a result and otherwise waits. */
export function ottoMood(state: { pending: boolean; hasResult: boolean }): OttoMood {
  if (state.pending) return 'thinking';
  return state.hasResult ? 'happy' : 'idle';
}

/** A message draft or a brief about one contact. Otto never sends anything. */
export function useOttoDraft() {
  return useMutation({
    mutationFn: async (body: OttoDraftRequest) =>
      throwIfFailed(await api.POST('/api/v1/otto/drafts', { body }), 'Otto could not answer.'),
  });
}

/** What happened since the last digest. */
export function useOttoDigest() {
  return useMutation({
    mutationFn: async () =>
      throwIfFailed(await api.POST('/api/v1/otto/digest', { body: {} }), 'Otto could not answer.'),
  });
}

/** True when Otto needs a connection or an upgrade before it can answer (see Settings → Otto). */
export function needsOttoSetup(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'otto_not_connected' || error.code === 'otto_upgrade_required')
  );
}

type StreamPath = '/api/v1/otto/drafts/stream' | '/api/v1/otto/digest/stream';
const streamFetch = networkAwareFetch((...args) => globalThis.fetch(...args));

/** Splits server-sent event text into complete events; returns the unfinished rest. */
export function takeEvents(buffer: string): {
  events: { event: string; data: string }[];
  rest: string;
} {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  const events = blocks.flatMap((block) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length > 0 ? [{ event, data: data.join('\n') }] : [];
  });
  return { events, rest };
}

/**
 * Asks Otto with the answer streamed: `onText` gets each piece as Otto writes it, and the promise
 * resolves with the stored draft. Failures throw the same errors as the JSON routes.
 */
export async function streamOtto(
  path: StreamPath,
  body: OttoDraftRequest | Record<string, never>,
  onText: (delta: string) => void,
): Promise<OttoDraft> {
  const response = await streamFetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.includes('text/event-stream') || !response.body) {
    const json = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string } | null;
    } | null;
    throw new ApiError(
      response.status,
      json?.error?.message ?? 'Otto could not answer.',
      json?.error?.code,
    );
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const taken = takeEvents(buffer + value);
      buffer = taken.rest;
      for (const { event, data } of taken.events) {
        const parsed = JSON.parse(data) as { text?: string; code?: string; message?: string };
        if (event === 'delta' && typeof parsed.text === 'string') onText(parsed.text);
        else if (event === 'done') return parsed as unknown as OttoDraft;
        else if (event === 'error') {
          throw new ApiError(503, parsed.message ?? 'Otto could not answer.', parsed.code);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  throw new ApiError(503, 'Otto stopped before it finished.', 'ai_unavailable');
}

export const ottoConnectionQueryKey = ['otto', 'connection'] as const;

/** How Otto reaches a model for this workspace (Settings → Otto). */
export function useOttoConnection() {
  return useQuery({
    queryKey: ottoConnectionQueryKey,
    queryFn: async () =>
      throwIfFailed(
        await api.GET('/api/v1/otto/connection'),
        "We couldn't load Otto's connection.",
      ),
  });
}

/** Saves the workspace's own OpenAI key. The key is checked with OpenAI first, and never shown again. */
export function useSaveOttoKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (apiKey: string) =>
      throwIfFailed(
        await api.PUT('/api/v1/otto/connection/key', { body: { apiKey } }),
        'We could not save the key.',
      ),
    onSuccess: (status) => queryClient.setQueryData(ottoConnectionQueryKey, status),
  });
}

/** Removes the workspace's own key or ChatGPT sign-in. */
export function useDisconnectOtto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      throwIfFailed(await api.DELETE('/api/v1/otto/connection'), 'We could not disconnect Otto.'),
    onSuccess: (status) => queryClient.setQueryData(ottoConnectionQueryKey, status),
  });
}

/** Starts "Sign in with ChatGPT": the browser leaves for OpenAI and comes back to Settings. */
export function useStartChatGptSignIn() {
  return useMutation({
    mutationFn: async () =>
      throwIfFailed(
        await api.POST('/api/v1/otto/connection/chatgpt'),
        'We could not start the ChatGPT sign-in.',
      ),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

/** Our own wording for a failed key save. */
export function ottoKeyErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'We could not reach KNOQRA. Check your connection and try again.';
  }
  if (error instanceof ApiError) {
    if (error.code === 'invalid_api_key')
      return 'OpenAI did not accept this key. Check it and try again.';
    if (error.code === 'validation_error') return 'That does not look like an OpenAI API key.';
    if (error.status === 503)
      return 'We could not reach OpenAI to check the key. Try again in a minute.';
    if (error.status === 403) return 'Only owners and admins can connect Otto.';
  }
  return 'We could not save the key. Try again.';
}

import type { components } from '@knoqra/api-client';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api, NetworkError, throwIfFailed } from './api';

export type OttoDraft = components['schemas']['OttoDraft'];
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
export function ottoErrorMessage(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'We could not reach KNOQRA. Check your connection and try again.';
  }
  if (error instanceof ApiError) {
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

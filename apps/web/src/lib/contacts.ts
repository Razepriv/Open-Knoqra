import type { components } from '@knoqra/api-client';
import { gradients } from '@knoqra/tokens';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError, api, NetworkError, throwIfFailed } from './api';
import { copy, looksLikeEmail } from './auth-errors';
import { formatTimeIn } from './format';
import { OFFLINE_FAILS_FAST } from './query-state';

export type Contact = components['schemas']['Contact'];
export type CreateContactBody = components['schemas']['CreateContact'];

/** Query key roots. The list key is `['contacts', q]`; a single contact is `['contact', id]`. */
export const contactsKey = ['contacts'] as const;
export const contactRoot = ['contact'] as const;
export const contactKey = (id: string) => [...contactRoot, id] as const;

// --- Pure helpers -----------------------------------------------------------------------------

type AvatarGradient = Exclude<keyof typeof gradients, 'hl'>;

/** `hl` is the highlight gradient, kept for emphasis; avatars use the other seven. */
const AVATAR_GRADIENTS = (Object.keys(gradients) as (keyof typeof gradients)[]).filter(
  (name): name is AvatarGradient => name !== 'hl',
);

/** The same id always gets the same avatar gradient, so a person keeps their colour everywhere. */
export function gradientFor(id: string): AvatarGradient {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  const pick = AVATAR_GRADIENTS[(hash >>> 0) % AVATAR_GRADIENTS.length];
  return pick ?? 'grey';
}

export interface ContactFormError {
  /** Which field to show the message beside; `form` means the dialog as a whole. */
  field: 'phone' | 'form';
  message: string;
}

const PHONE_COPY = 'Enter a full number with country code, like +1 202 555 0123.';
const DUPLICATE_COPY = 'A contact with this number already exists.';

/** Our own wording for what the API said, so no server text or error code reaches the screen raw. */
export function contactErrorMessage(error: unknown): ContactFormError {
  if (error instanceof NetworkError) {
    return {
      field: 'form',
      message: 'We could not reach KNOQRA. Check your connection and try again.',
    };
  }
  if (error instanceof ApiError) {
    if (error.code === 'invalid_phone') return { field: 'phone', message: PHONE_COPY };
    if (error.code === 'duplicate_contact') {
      // The API says when the number belongs to an archived contact, which changes what the person
      // should do next, so that wording is worth keeping. A merged contact releases its number.
      const detail = /archived/i.test(error.message) ? error.message : DUPLICATE_COPY;
      return { field: 'phone', message: detail };
    }
    if (error.code === 'validation_error') {
      return { field: 'form', message: 'Some details are not valid. Check them and try again.' };
    }
  }
  return { field: 'form', message: 'We could not save this contact. Try again in a moment.' };
}

export interface ContactFieldErrors {
  displayName?: string;
  phone?: string;
  email?: string;
}

/** Client-side checks that save a round trip. The API stays the authority on phone numbers. */
export function validateContactFields(values: {
  displayName: string;
  phone: string;
  email: string;
}): ContactFieldErrors {
  const errors: ContactFieldErrors = {};
  if (!values.displayName.trim()) errors.displayName = 'Enter a name.';
  if (!values.phone.trim()) errors.phone = 'Enter a phone number.';
  const email = values.email.trim();
  if (email && !looksLikeEmail(email)) errors.email = copy.emailInvalid;
  return errors;
}

/** "vip, lead,,VIP" → ["vip", "lead"]: trimmed, no blanks, no case-insensitive repeats. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** +12025550123 → "+1 202 555 0123". Numbers outside the North American plan stay as stored. */
export function formatPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return match ? `+1 ${match[1]} ${match[2]} ${match[3]}` : e164;
}

/** The time of day in `timeZone`, or null when there is no zone or the runtime does not know it. */
export function localTimeIn(
  timeZone: string | null | undefined,
  at: Date = new Date(),
  locale?: string,
): string | null {
  if (!timeZone) return null;
  try {
    return formatTimeIn(timeZone, at, locale);
  } catch {
    return null;
  }
}

// --- Queries ----------------------------------------------------------------------------------

/** Contacts matching `q`, 50 at a time, following the API's opaque `nextCursor`. */
export function useContacts({ q }: { q: string }) {
  return useInfiniteQuery({
    queryKey: [...contactsKey, q],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts', {
          params: { query: { ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) } },
          signal,
        }),
        'Could not load your contacts.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Typing in the search box keeps the old rows on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** A small, cached contact search for the command palette. */
export function useContactSearch(q: string, enabled: boolean, limit: number) {
  return useQuery({
    queryKey: [...contactsKey, 'search', q, limit],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts', {
          params: { query: { ...(q ? { q } : {}), limit } },
          signal,
        }),
        'Could not load your contacts.',
      ),
  });
}

/** Creates a contact, then refreshes every list. Callers map failures with `contactErrorMessage`. */
export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (body: CreateContactBody) =>
      throwIfFailed(await api.POST('/api/v1/contacts', { body }), 'Could not save this contact.'),
    // A new contact can be a duplicate of any open one, so every cached suggestion is stale.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: contactsKey }),
        queryClient.invalidateQueries({ queryKey: ['duplicates'] }),
      ]),
  });
}

/** What a screen reader hears after a search settles; empty while loading or after an error. */
export function resultAnnouncement(state: {
  settled: boolean;
  count: number;
  more: boolean;
  searching: boolean;
}): string {
  if (!state.settled) return '';
  if (state.count === 0) {
    return state.searching ? 'No contacts match your search.' : 'No contacts yet.';
  }
  const noun = state.count === 1 && !state.more ? 'contact' : 'contacts';
  return `${state.count}${state.more ? '+' : ''} ${noun}`;
}

/** "Search 5 people" when the whole list is known, else plain "Search contacts". */
export function searchPlaceholder(count: number | null): string {
  if (count === null || count === 0) return 'Search contacts';
  return count === 1 ? 'Search 1 person' : `Search ${count} people`;
}

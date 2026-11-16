import { NAV_ITEMS, SETTINGS_ITEM } from './nav-items';

export const TASK_TITLE_MAX = 200;

export interface PaletteDestination {
  label: string;
  to: string;
}

export interface PaletteActions {
  navigate: PaletteDestination[];
  /** The trimmed query as a task title, or null when it is empty or too long. */
  createTask: string | null;
}

/** Tasks is not in the rail; the palette lists it after Contacts. */
function destinations(): PaletteDestination[] {
  const items: PaletteDestination[] = [...NAV_ITEMS, SETTINGS_ITEM].map(({ label, to }) => ({
    label,
    to,
  }));
  const at = items.findIndex((i) => i.label === 'Contacts') + 1;
  return [...items.slice(0, at), { label: 'Tasks', to: '/tasks' }, ...items.slice(at)];
}

export interface ContactSearchState<T> {
  query: string;
  debounced: string;
  isPlaceholderData: boolean;
  items: readonly T[] | undefined;
}

/** Contact rows to show: only those fetched for exactly what is typed now, never a stale list. */
export function currentContacts<T>(state: ContactSearchState<T>, limit: number): T[] {
  const typed = state.query.trim();
  if (typed.length === 0 || state.debounced !== typed || state.isPlaceholderData) return [];
  return (state.items ?? []).slice(0, limit);
}

/** What the palette offers for `query`: matching destinations and, maybe, a task to create. */
export function paletteActions(query: string): PaletteActions {
  const title = query.trim();
  const needle = title.toLowerCase();
  return {
    navigate: destinations().filter((d) => d.label.toLowerCase().includes(needle)),
    createTask: title.length >= 1 && title.length <= TASK_TITLE_MAX ? title : null,
  };
}

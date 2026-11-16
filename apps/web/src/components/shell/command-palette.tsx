import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { useEffect, useRef, useState } from 'react';
import { useContactSearch } from '../../lib/contacts';
import { currentContacts, paletteActions } from '../../lib/palette';
import { useCreateTask } from '../../lib/tasks';
import { dialogOverlay } from '../../lib/ui-classes';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { PaletteResultsSkeleton } from '../skeletons/overlay-skeletons';
import { useToast } from '../use-toast';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SEARCH_DEBOUNCE_MS = 200;
const CONTACT_LIMIT = 5;

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-[14px] px-3 py-2.5 text-[14px] data-[selected=true]:bg-[color:var(--pressed)]';
const GROUP_CLASS =
  'px-1 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-[family-name:var(--font-mono)] [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.04em] [&_[cmdk-group-heading]]:text-[color:var(--muted)]';

/** Remembers the last element focused outside the palette and puts focus back when it closes. */
function useRestoreFocus(open: boolean) {
  const last = useRef<HTMLElement | null>(null);
  const saved = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (el instanceof HTMLElement && !el.closest('[cmdk-root], [role="dialog"]')) {
        last.current = el;
      }
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);
  useEffect(() => {
    if (open) {
      saved.current = last.current;
      return;
    }
    const target = saved.current;
    saved.current = null;
    if (!target?.isConnected) return;
    const id = setTimeout(() => target.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);
}

/** Ctrl/Cmd+K: jump to a page or a contact, or add a task from whatever you typed. */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const navigate = useNavigate();
  const createTask = useCreateTask();
  const { show, toast } = useToast();
  const debounced = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const contacts = useContactSearch(debounced, open && debounced.length > 0, CONTACT_LIMIT);
  const actions = paletteActions(query);
  const matches = currentContacts(
    {
      query,
      debounced,
      isPlaceholderData: contacts.isPlaceholderData,
      items: contacts.data?.items,
    },
    CONTACT_LIMIT,
  );
  // Typed, but the contacts for exactly this text are not in yet: show where they will land.
  const searching =
    query.trim().length > 0 &&
    matches.length === 0 &&
    (debounced !== query.trim() || contacts.isFetching);
  const creating = useRef(false);
  useRestoreFocus(open);

  // Results arrive after the keystroke, so keep the highlight on the first one, as a user expects.
  const first = actions.navigate[0]
    ? `nav:${actions.navigate[0].to}`
    : matches[0]
      ? `contact:${matches[0].id}`
      : actions.createTask
        ? 'create-task'
        : '';
  useEffect(() => setSelected(first), [first]);

  const change = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };
  const go = (to: string) => {
    change(false);
    void navigate({ to });
  };
  const create = () => {
    const title = actions.createTask;
    if (!title || creating.current) return;
    creating.current = true;
    createTask.mutate(
      { title },
      {
        onSettled: () => {
          creating.current = false;
        },
        onSuccess: () => {
          show('Task added.');
          change(false);
        },
        onError: () => show('Could not save this task.'),
      },
    );
  };

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={change}
        label="Command palette"
        shouldFilter={false}
        value={selected}
        onValueChange={setSelected}
        overlayClassName={dialogOverlay}
        contentClassName="fixed top-[18vh] left-1/2 z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-[22px] border border-[color:var(--panelBorder)] bg-[color:var(--shell)] p-2 text-[color:var(--text)] [box-shadow:var(--panelShadow)]"
      >
        <Command.Input
          aria-label="Command palette"
          placeholder="Search, jump or create…"
          value={query}
          onValueChange={setQuery}
          className="mb-2 h-11 w-full rounded-full bg-[color:var(--cell)] px-4 text-[15px] text-[color:var(--text)] outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)]"
        />
        {/* Outside the listbox (a listbox may hold only options and groups); always mounted, so
            the change is announced. */}
        <p role="status" className="sr-only">
          {searching ? 'Searching contacts' : ''}
        </p>
        <Command.List className="max-h-[50vh] overflow-auto">
          {actions.navigate.length > 0 ? (
            <Command.Group heading="Navigate" className={GROUP_CLASS}>
              {actions.navigate.map((d) => (
                <Command.Item
                  key={d.to}
                  value={`nav:${d.to}`}
                  onSelect={() => go(d.to)}
                  className={ITEM_CLASS}
                >
                  {d.label}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
          {matches.length > 0 ? (
            <Command.Group heading="Contacts" className={GROUP_CLASS}>
              {matches.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`contact:${c.id}`}
                  onSelect={() => go(`/contacts/${c.id}`)}
                  className={ITEM_CLASS}
                >
                  <span className="font-medium">{c.displayName}</span>
                  {c.company ? (
                    <span className="text-[12px] text-[color:var(--muted)]">{c.company}</span>
                  ) : null}
                </Command.Item>
              ))}
            </Command.Group>
          ) : searching ? (
            <PaletteResultsSkeleton />
          ) : null}
          {actions.createTask ? (
            <Command.Group heading="Create" className={GROUP_CLASS}>
              <Command.Item
                value="create-task"
                disabled={createTask.isPending}
                onSelect={create}
                className={ITEM_CLASS}
              >
                Create task: {actions.createTask}
              </Command.Item>
            </Command.Group>
          ) : null}
        </Command.List>
      </Command.Dialog>
      {toast}
    </>
  );
}

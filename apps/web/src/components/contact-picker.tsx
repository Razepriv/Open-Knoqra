import * as Popover from '@radix-ui/react-popover';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { ChevronDown, X } from 'lucide-react';
import { useState } from 'react';
import { api, throwIfFailed } from '../lib/api';
import { contactsKey } from '../lib/contacts';
import { focusRing, menuSurface } from '../lib/ui-classes';
import { useDebouncedValue } from '../lib/use-debounced-value';

export interface PickedContact {
  id: string;
  displayName: string;
}

export interface ContactPickerProps {
  value: PickedContact | null;
  onChange: (value: PickedContact | null) => void;
  label: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const RESULT_LIMIT = 8;

function useContactSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: [...contactsKey, 'picker', q],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/contacts', {
          params: { query: { ...(q ? { q } : {}), limit: RESULT_LIMIT } },
          signal,
        }),
        'Could not load your contacts.',
      ),
  });
}

/** Chooses one contact by searching, or none. A popover with a type-ahead list. */
export function ContactPicker({ value, onChange, label }: ContactPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const q = useDebouncedValue(draft.trim(), SEARCH_DEBOUNCE_MS);
  const search = useContactSearch(q, open);
  const items = search.data?.items.slice(0, RESULT_LIMIT) ?? [];

  return (
    <div className="flex flex-col">
      <span aria-hidden="true" className="mb-2 font-medium text-[13px] text-[color:var(--text)]">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            // The name carries the choice too, so a screen reader hears who is picked.
            aria-label={`${label}: ${value ? value.displayName : 'No contact'}`}
            className={`flex h-12 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 text-left text-[15px] [box-shadow:var(--cellShadow)] ${focusRing}`}
          >
            <span
              className={`truncate ${value ? 'text-[color:var(--text)]' : 'text-[color:var(--muted)]'}`}
            >
              {value ? value.displayName : 'No contact'}
            </span>
            <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={8}
              className={`${menuSurface} w-[min(360px,calc(100vw-24px))] p-2`}
            >
              <Command shouldFilter={false} label="Search contacts">
                <Command.Input
                  aria-label="Search contacts"
                  placeholder="Search by name, company or number"
                  value={draft}
                  onValueChange={setDraft}
                  className="mb-2 h-10 w-full rounded-full bg-[color:var(--cell)] px-4 text-[14px] text-[color:var(--text)] outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)]"
                />
                <Command.List className="max-h-64 overflow-auto">
                  {search.isError && items.length === 0 ? (
                    <p
                      role="alert"
                      className="px-3 py-2 text-[13px] text-[color:var(--danger-text)]"
                    >
                      We could not load your contacts.
                    </p>
                  ) : items.length === 0 && !search.isPending ? (
                    <Command.Empty className="px-3 py-2 text-[13px] text-[color:var(--muted)]">
                      No contacts match.
                    </Command.Empty>
                  ) : null}
                  {items.map((contact) => (
                    <Command.Item
                      key={contact.id}
                      value={contact.id}
                      onSelect={() => {
                        onChange({ id: contact.id, displayName: contact.displayName });
                        setOpen(false);
                      }}
                      className="flex cursor-pointer flex-col gap-1 rounded-[14px] px-3 py-2 text-[14px] data-[selected=true]:bg-[color:var(--pressed)]"
                    >
                      <span className="font-medium">{contact.displayName}</span>
                      {contact.company ? (
                        <span className="text-[12px] text-[color:var(--muted)]">
                          {contact.company}
                        </span>
                      ) : null}
                    </Command.Item>
                  ))}
                </Command.List>
              </Command>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {value ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => onChange(null)}
            className={`flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)] ${focusRing}`}
          >
            <X size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

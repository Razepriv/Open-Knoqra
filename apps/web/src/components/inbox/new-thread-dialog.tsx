import { Button, Reveal, Skeleton } from '@knoqra/ui';
import { type FormEvent, useId, useMemo, useState } from 'react';
import {
  type Contact,
  contactErrorMessage,
  formatPhone,
  useContacts,
  useCreateContact,
} from '../../lib/contacts';
import { dialTarget } from '../../lib/dial';
import { useOpenConversation } from '../../lib/inbox';
import { CHANNEL_LABEL, type InboxChannel } from '../../lib/inbox-format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { FormAlert } from '../form-alert';

export interface NewThreadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the conversation id once it is open. */
  onOpened: (conversationId: string) => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

export function NewThreadDialog({
  open,
  onOpenChange,
  onOpened,
  returnFocus,
}: NewThreadDialogProps) {
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="New message"
      description="Pick a contact or type a phone number, then choose the channel."
      initialFocusId="new-thread-search"
      {...(returnFocus ? { returnFocus } : {})}
    >
      {/* A fresh form on every open: Radix unmounts the content when the dialog closes. */}
      <NewThreadForm
        onOpened={(id) => {
          onOpenChange(false);
          onOpened(id);
        }}
      />
    </DialogShell>
  );
}

const CHANNELS: InboxChannel[] = ['sms', 'whatsapp'];

function NewThreadForm({ onOpened }: { onOpened: (id: string) => void }) {
  const [draft, setDraft] = useState('');
  const q = useDebouncedValue(draft.trim(), 250);
  const [contactId, setContactId] = useState<string | null>(null);
  /** A typed number that is not a saved contact yet: saved as one when the conversation opens. */
  const [newNumber, setNewNumber] = useState<string | null>(null);
  const [channel, setChannel] = useState<InboxChannel>('sms');
  const [error, setError] = useState<string | null>(null);
  const contacts = useContacts({ q });
  const open = useOpenConversation();
  const create = useCreateContact();
  const groupId = useId();
  const items: Contact[] = useMemo(
    () => contacts.data?.pages.flatMap((page) => page.items) ?? [],
    [contacts.data],
  );
  // What the user typed, read as a phone number. Offered as a new number only when no saved
  // contact already has it, so messaging someone twice never makes a duplicate contact.
  const typed = dialTarget(draft);
  const savedMatch = typed ? items.find((contact) => contact.phoneE164 === typed) : undefined;
  const offerNew = typed !== null && savedMatch === undefined && !contacts.isPending;
  const chosenNew = offerNew && newNumber === typed ? typed : null;
  const busy = open.isPending || create.isPending;

  function pickContact(id: string) {
    setContactId(id);
    setNewNumber(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!contactId && !chosenNew)) return;
    setError(null);
    let id = contactId;
    if (chosenNew) {
      try {
        const created = await create.mutateAsync({
          displayName: formatPhone(chosenNew),
          phone: chosenNew,
        });
        id = created.id;
      } catch (caught) {
        setError(contactErrorMessage(caught).message);
        return;
      }
    }
    if (!id) return;
    try {
      const conversation = await open.mutateAsync({ contactId: id, channel });
      onOpened(conversation.id);
    } catch {
      setError('We could not open this conversation. Try again.');
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FormAlert message={error} />
      <input
        id="new-thread-search"
        type="search"
        aria-label="Search contacts or type a number"
        placeholder="Name, company, or a phone number"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-11 rounded-full bg-[color:var(--cell)] px-4 text-[14px] text-[color:var(--text)] outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
      />
      {offerNew && typed ? (
        <button
          type="button"
          aria-pressed={chosenNew !== null}
          onClick={() => {
            setNewNumber(typed);
            setContactId(null);
          }}
          className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-[16px] border border-dashed border-[color:var(--pillBorder)] px-3 py-2 text-left text-[14px] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2 ${
            chosenNew !== null
              ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
              : 'hover:bg-[color:var(--cell)]'
          }`}
        >
          <span className="truncate font-medium">{`Message ${formatPhone(typed)}`}</span>
          <span className="shrink-0 text-[12px] text-[color:var(--muted)]">
            New number · saved to Contacts
          </span>
        </button>
      ) : null}
      <Reveal loading={contacts.isPending}>
        {contacts.isPending ? (
          <Skeleton lines={4} widths={[70, 55, 80, 50]} label="Loading contacts" />
        ) : items.length === 0 ? (
          <p className="text-[14px] text-[color:var(--muted)]">
            {offerNew
              ? 'No saved contact has this number.'
              : q
                ? `No contacts match "${q}". Type a full phone number to message someone new.`
                : 'No contacts yet. Type a phone number to message someone new.'}
          </p>
        ) : (
          <ul aria-label="Contacts" className="flex max-h-[220px] flex-col gap-1 overflow-auto">
            {items.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  aria-pressed={contact.id === contactId}
                  onClick={() => pickContact(contact.id)}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-[16px] px-3 py-2 text-left text-[14px] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2 ${
                    contact.id === contactId
                      ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
                      : 'hover:bg-[color:var(--cell)]'
                  }`}
                >
                  <span className="truncate font-medium">{contact.displayName}</span>
                  <span className="shrink-0 font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)]">
                    {contact.phoneE164}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Reveal>
      <fieldset className="flex gap-4 border-0 p-0">
        <legend className="mb-2 font-medium text-[13px]">Channel</legend>
        {CHANNELS.map((value) => (
          <label key={value} className="flex cursor-pointer items-center gap-2 text-[14px]">
            <input
              type="radio"
              name={groupId}
              value={value}
              checked={channel === value}
              onChange={() => setChannel(value)}
              className="size-4 accent-[color:var(--line)]"
            />
            {CHANNEL_LABEL[value]}
          </label>
        ))}
      </fieldset>
      <div className="mt-2 flex justify-end gap-2">
        <DialogCancel />
        <Button
          type="submit"
          variant="primary"
          disabled={(!contactId && !chosenNew) || busy}
          aria-busy={busy}
        >
          Open conversation
        </Button>
      </div>
    </form>
  );
}

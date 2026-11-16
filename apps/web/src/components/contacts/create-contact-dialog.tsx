import { Button } from '@knoqra/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useState } from 'react';
import { useMe } from '../../lib/api';
import {
  type ContactFieldErrors,
  type ContactFormError,
  contactErrorMessage,
  parseTags,
  useCreateContact,
  validateContactFields,
} from '../../lib/contacts';
import { haptic } from '../../lib/haptics';
import { track } from '../../lib/observability/analytics';
import { DialogShell } from '../dialog-shell';
import { FormAlert } from '../form-alert';
import { useToast } from '../use-toast';
import { ContactFields, readContactValues } from './contact-fields';

export interface CreateContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close: the control that opened the dialog, or a fallback if it is gone. */
  returnFocus?: () => HTMLElement | null | undefined;
}

export function CreateContactDialog({ open, onOpenChange, returnFocus }: CreateContactDialogProps) {
  // The toast lives out here: the form below unmounts as soon as the dialog closes.
  const { show, toast } = useToast();
  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        title="Add contact"
        description="Numbers need a country code. Consent is tracked per channel once the contact exists."
        initialFocusId="contact-name"
        {...(returnFocus ? { returnFocus } : {})}
      >
        {/* A fresh form on every open: Radix unmounts the content when the dialog closes. */}
        <CreateContactForm
          onDone={(name) => {
            onOpenChange(false);
            show(`Added ${name}.`);
          }}
        />
      </DialogShell>
      {toast}
    </>
  );
}

function CreateContactForm({ onDone }: { onDone: (name: string) => void }) {
  const me = useMe();
  const create = useCreateContact();
  const [fieldErrors, setFieldErrors] = useState<ContactFieldErrors>({});
  const [serverError, setServerError] = useState<ContactFormError | null>(null);
  // Stays true after success so a double click cannot add the contact twice before the dialog closes.
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted) return;
    const values = readContactValues(new FormData(event.currentTarget));

    const errors = validateContactFields(values);
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitted(true);
    try {
      const tags = parseTags(values.tags);
      await create.mutateAsync({
        displayName: values.displayName,
        phone: values.phone,
        ...(values.company ? { company: values.company } : {}),
        ...(values.email ? { email: values.email } : {}),
        ...(values.timezone ? { timezone: values.timezone } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      });
      track('contact_created', {});
      haptic('success');
      onDone(values.displayName);
    } catch (error) {
      setSubmitted(false);
      haptic('error');
      setServerError(contactErrorMessage(error));
    }
  }

  const phoneError =
    fieldErrors.phone ?? (serverError?.field === 'phone' ? serverError.message : null);

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <FormAlert message={serverError?.field === 'form' ? serverError.message : null} />
      <ContactFields
        defaultTimezone={me.data?.prefs.timezone}
        fieldErrors={fieldErrors}
        phoneError={phoneError}
        onPhoneChange={() => {
          if (serverError?.field === 'phone') setServerError(null);
        }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Dialog.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </Dialog.Close>
        <Button type="submit" variant="primary" disabled={submitted} aria-busy={create.isPending}>
          {submitted ? 'Adding…' : 'Add contact'}
        </Button>
      </div>
    </form>
  );
}

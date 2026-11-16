import { Button } from '@knoqra/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { type FormEvent, useState } from 'react';
import { useUpdateContact } from '../../lib/contact360-queries';
import {
  type Contact,
  type ContactFieldErrors,
  type ContactFormError,
  contactErrorMessage,
  parseTags,
  validateContactFields,
} from '../../lib/contacts';
import { haptic } from '../../lib/haptics';
import { ContactFields, readContactValues } from '../contacts/contact-fields';
import { DialogShell } from '../dialog-shell';
import { FormAlert } from '../form-alert';
import { useToast } from '../use-toast';

export interface EditContactDialogProps {
  contact: Contact;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: () => HTMLElement | null | undefined;
}

export function EditContactDialog({
  contact,
  open,
  onOpenChange,
  returnFocus,
}: EditContactDialogProps) {
  // The toast lives out here: the form below unmounts as soon as the dialog closes.
  const { show, toast } = useToast();
  return (
    <>
      <DialogShell
        open={open}
        onOpenChange={onOpenChange}
        title="Edit contact"
        description="Consent and history stay with this contact, even if the number changes."
        initialFocusId="contact-name"
        {...(returnFocus ? { returnFocus } : {})}
      >
        <EditContactForm
          contact={contact}
          onDone={() => {
            onOpenChange(false);
            show('Contact updated.');
          }}
        />
      </DialogShell>
      {toast}
    </>
  );
}

function EditContactForm({ contact, onDone }: { contact: Contact; onDone: () => void }) {
  const update = useUpdateContact(contact.id);
  const [fieldErrors, setFieldErrors] = useState<ContactFieldErrors>({});
  const [serverError, setServerError] = useState<ContactFormError | null>(null);
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
      // An empty string clears an optional field on the server.
      await update.mutateAsync({
        displayName: values.displayName,
        phone: values.phone,
        company: values.company,
        email: values.email,
        jobTitle: values.jobTitle,
        timezone: values.timezone || null,
        tags: parseTags(values.tags),
      });
      haptic('success');
      onDone();
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
        contact={contact}
        withJobTitle
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
        <Button type="submit" variant="primary" disabled={submitted} aria-busy={update.isPending}>
          {submitted ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

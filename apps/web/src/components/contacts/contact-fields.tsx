import { useMemo } from 'react';
import { type Contact, type ContactFieldErrors, formatPhone } from '../../lib/contacts';
import { timeZoneOptions } from '../../lib/timezones';
import { Field } from '../field';
import { SelectField } from '../select-field';

/** The text boxes of the contact form, read from a submitted form. */
export interface ContactValues {
  displayName: string;
  phone: string;
  company: string;
  email: string;
  jobTitle: string;
  timezone: string;
  tags: string;
}

export function readContactValues(form: FormData): ContactValues {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  return {
    displayName: text('displayName'),
    phone: text('phone'),
    company: text('company'),
    email: text('email'),
    jobTitle: text('jobTitle'),
    timezone: text('timezone'),
    tags: text('tags'),
  };
}

export interface ContactFieldsProps {
  /** Set when editing: the fields start with this contact's values. */
  contact?: Contact;
  /** The zone to preselect when there is no contact: the user's own preference. */
  defaultTimezone?: string | null;
  withJobTitle?: boolean;
  fieldErrors: ContactFieldErrors;
  phoneError: string | null;
  onPhoneChange: () => void;
}

/** Shared by the Add contact and Edit contact dialogs. Fields are uncontrolled. */
export function ContactFields({
  contact,
  defaultTimezone,
  withJobTitle = false,
  fieldErrors,
  phoneError,
  onPhoneChange,
}: ContactFieldsProps) {
  const timezone = contact ? (contact.timezone ?? '') : (defaultTimezone ?? '');
  const zones = useMemo(() => timeZoneOptions(timezone || null), [timezone]);
  return (
    <>
      <Field
        id="contact-name"
        name="displayName"
        label="Name"
        required
        autoComplete="off"
        defaultValue={contact?.displayName}
        error={fieldErrors.displayName ?? null}
      />
      <Field
        id="contact-phone"
        name="phone"
        label="Phone"
        type="tel"
        required
        autoComplete="off"
        defaultValue={contact ? formatPhone(contact.phoneE164) : undefined}
        hint="Include the country code, like +1 202 555 0123."
        error={phoneError}
        onChange={onPhoneChange}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="contact-company"
          name="company"
          label="Company"
          autoComplete="off"
          defaultValue={contact?.company ?? ''}
        />
        <Field
          id="contact-email"
          name="email"
          label="Email"
          type="email"
          autoComplete="off"
          defaultValue={contact?.email ?? ''}
          error={fieldErrors.email ?? null}
        />
      </div>
      {withJobTitle ? (
        <Field
          id="contact-job-title"
          name="jobTitle"
          label="Job title"
          autoComplete="off"
          defaultValue={contact?.jobTitle ?? ''}
        />
      ) : null}
      <SelectField id="contact-timezone" name="timezone" label="Time zone" defaultValue={timezone}>
        <option value="">Not set</option>
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </SelectField>
      <Field
        id="contact-tags"
        name="tags"
        label="Tags"
        autoComplete="off"
        defaultValue={contact?.tags.join(', ') ?? ''}
        hint="Separate tags with commas."
      />
    </>
  );
}

import { Button } from '@knoqra/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type Me, meQueryKey, throwIfFailed } from '../../lib/api';
import { displayNameError } from '../../lib/auth-errors';
import { ProfileSaveError } from '../../lib/profile';
import { browserTimeZone, timeZoneOptions } from '../../lib/timezones';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SelectField } from '../select-field';
import { useToast } from '../use-toast';
import { SettingsSection } from './section';

interface ProfileChanges {
  name?: string;
  timezone?: string | null;
}

/** Two requests, name then time zone. A failure says which one, and whether the name was kept. */
async function saveProfile(changes: ProfileChanges): Promise<void> {
  let nameSaved = false;
  if (changes.name !== undefined) {
    try {
      throwIfFailed(
        await api.PATCH('/api/v1/me', { body: { name: changes.name } }),
        'Could not save your name.',
      );
    } catch {
      throw new ProfileSaveError('name', false);
    }
    nameSaved = true;
  }
  if (changes.timezone !== undefined) {
    try {
      throwIfFailed(
        await api.PATCH('/api/v1/me/prefs', { body: { timezone: changes.timezone } }),
        'Could not save your time zone.',
      );
    } catch {
      throw new ProfileSaveError('timezone', nameSaved);
    }
  }
}

/** The section's own heading, shared with its loading outline so the two stay the same height. */
export const PROFILE_SECTION = {
  id: 'profile',
  title: 'Profile',
  description: 'How you appear in KNOQRA, and the time zone your call times are shown in.',
} as const;

/** Name and time zone. The email is shown but cannot be changed here. */
export function ProfileSection({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const { show, toast } = useToast();
  const savedZone = me.prefs.timezone ?? '';
  const [name, setName] = useState(me.user.name);
  const [timezone, setTimezone] = useState(savedZone);
  const [nameError, setNameError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const deviceZone = browserTimeZone();

  const save = useMutation({
    mutationFn: saveProfile,
    onSuccess: () => show('Profile saved'),
    onError: (error) =>
      setFormError(
        error instanceof ProfileSaveError
          ? error.message
          : 'We could not save your profile. Try again in a moment.',
      ),
    // Reload either way: after a half-failed save the server, not this form, is the truth.
    onSettled: () => queryClient.invalidateQueries({ queryKey: meQueryKey }),
  });

  const trimmed = name.trim();
  const dirty = trimmed !== me.user.name || timezone !== savedZone;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const error = displayNameError(trimmed);
    setNameError(error);
    if (error) return;
    const changes: ProfileChanges = {};
    if (trimmed !== me.user.name) changes.name = trimmed;
    if (timezone !== savedZone) changes.timezone = timezone || null;
    save.mutate(changes);
  }

  return (
    <SettingsSection {...PROFILE_SECTION}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field
          id="profile-name"
          name="name"
          label="Name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError}
        />
        <Field
          id="profile-email"
          label="Account email"
          value={me.user.email}
          readOnly
          hint="Your sign-in address. Contact support to change it."
        />
        <SelectField
          id="profile-timezone"
          label="Time zone"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          hint={deviceZone ? `This device is on ${deviceZone}.` : undefined}
        >
          <option value="">Not set (use this device)</option>
          {timeZoneOptions(me.prefs.timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </SelectField>
        <FormAlert message={formError} />
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || save.isPending}
          aria-busy={save.isPending}
          className="h-11 self-start px-6"
        >
          Save profile
        </Button>
      </form>
      {toast}
    </SettingsSection>
  );
}

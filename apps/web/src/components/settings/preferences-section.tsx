import { Pill } from '@knoqra/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Me, meQueryKey, throwIfFailed } from '../../lib/api';
import { webObservability } from '../../lib/observability/config';
import type { ThemePreference } from '../../lib/theme';
import { useThemePreference } from '../../lib/use-theme-preference';
import { CheckboxField } from '../checkbox-field';
import { FormAlert } from '../form-alert';
import { useToast } from '../use-toast';
import { SettingsSection } from './section';

type Prefs = Me['prefs'];
type PrefsPatch = Partial<
  Pick<Prefs, 'notifyEmail' | 'notifyDesktop' | 'analyticsConsent' | 'newsletter'>
>;

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const USAGE_HINT =
  'Which pages and features get used, never names, numbers or message content. No session recordings.';
const ANALYTICS_HINT = webObservability.posthog
  ? USAGE_HINT
  : `${USAGE_HINT} Usage analytics are switched off on this server, so nothing is sent.`;

async function savePrefs(patch: PrefsPatch): Promise<void> {
  throwIfFailed(
    await api.PATCH('/api/v1/me/prefs', { body: patch }),
    'Could not save your preferences.',
  );
}

/** The section's own heading, shared with its loading outline so the two stay the same height. */
export const PREFERENCES_SECTION = {
  id: 'preferences',
  title: 'Preferences',
  description: 'Appearance and how KNOQRA gets your attention.',
} as const;

/** Theme and notifications. Each change saves straight away and rolls back if it fails. */
export function PreferencesSection({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const { show, toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const { prefs } = me;
  const themePreference = useThemePreference();

  const save = useMutation({
    mutationFn: savePrefs,
    onMutate: async (patch) => {
      setError(null);
      await queryClient.cancelQueries({ queryKey: meQueryKey });
      const previous = queryClient.getQueryData<Me>(meQueryKey);
      queryClient.setQueryData<Me>(meQueryKey, (current) =>
        current ? { ...current, prefs: { ...current.prefs, ...patch } } : current,
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(meQueryKey, context.previous);
      setError('We could not save that. Try again in a moment.');
    },
    onSuccess: () => show('Preferences saved'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: meQueryKey }),
  });

  return (
    <SettingsSection {...PREFERENCES_SECTION}>
      <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <legend className="mb-3 p-0 font-medium text-[13px]">Theme</legend>
        <div className="flex flex-wrap gap-2">
          {THEMES.map(({ value, label }) => (
            <Pill
              key={value}
              pressed={themePreference.preference === value}
              onClick={() => themePreference.choose(value)}
              className="h-10 px-4"
            >
              {label}
            </Pill>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-5">
        <CheckboxField
          id="notify-email"
          label="Email notifications"
          hint="A summary of missed calls and new messages."
          checked={prefs.notifyEmail}
          onChange={(event) => save.mutate({ notifyEmail: event.target.checked })}
        />
        <CheckboxField
          id="notify-desktop"
          label="Desktop notifications"
          hint="Alerts on this computer while KNOQRA is open."
          checked={prefs.notifyDesktop}
          onChange={(event) => save.mutate({ notifyDesktop: event.target.checked })}
        />
        <CheckboxField
          id="newsletter"
          label="Product news"
          hint="New features and new blog posts by email, a few times a month at most."
          checked={prefs.newsletter}
          onChange={(event) => save.mutate({ newsletter: event.target.checked })}
        />
        <CheckboxField
          id="analytics-consent"
          label="Share anonymous usage data"
          hint={ANALYTICS_HINT}
          checked={prefs.analyticsConsent}
          onChange={(event) => save.mutate({ analyticsConsent: event.target.checked })}
        />
      </div>
      <FormAlert
        message={
          themePreference.saveFailed ? 'We could not save your theme. Try again in a moment.' : null
        }
      />
      <FormAlert message={error} />
      {toast}
    </SettingsSection>
  );
}

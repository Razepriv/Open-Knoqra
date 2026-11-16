import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, type Me, meQueryKey, throwIfFailed, useMe } from './api';
import { OFFLINE_FAILS_FAST } from './query-state';
import {
  applyTheme,
  nextThemePreference,
  parseThemePreference,
  type ThemePreference,
} from './theme';

const themeMutationKey = ['me', 'theme'] as const;

function currentPreference(me: Me | undefined): ThemePreference {
  return (
    me?.prefs.theme ?? parseThemePreference(document.documentElement.dataset.theme) ?? 'system'
  );
}

/**
 * The signed-in user's theme. The server preference wins once `/me` loads (it is applied here),
 * and a press on `cycle`, or `choose` for a named theme, shows it at once, then saves it. A failed save rolls back.
 */
export function useThemePreference() {
  const queryClient = useQueryClient();
  const me = useMe();
  const serverTheme = me.data?.prefs.theme;

  useEffect(() => {
    if (serverTheme) applyTheme(serverTheme);
  }, [serverTheme]);

  const save = useMutation({
    mutationKey: themeMutationKey,
    networkMode: OFFLINE_FAILS_FAST,
    mutationFn: async (theme: ThemePreference) =>
      throwIfFailed(
        await api.PATCH('/api/v1/me/prefs', { body: { theme } }),
        'Could not save your theme.',
      ),
    onMutate: async (theme) => {
      const previous = queryClient.getQueryData<Me>(meQueryKey);
      // Cancelling the very first /me fetch would leave the query pending with nothing to retry it.
      if (previous) {
        await queryClient.cancelQueries({ queryKey: meQueryKey });
        queryClient.setQueryData<Me>(meQueryKey, {
          ...previous,
          prefs: { ...previous.prefs, theme },
        });
      }
      applyTheme(theme);
      return { previous };
    },
    onError: (_error, _theme, context) => {
      if (!context?.previous) return;
      queryClient.setQueryData<Me>(meQueryKey, context.previous);
      applyTheme(context.previous.prefs.theme);
    },
    onSuccess: (prefs) => {
      const current = queryClient.getQueryData<Me>(meQueryKey);
      if (current) queryClient.setQueryData<Me>(meQueryKey, { ...current, prefs });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: meQueryKey }),
  });

  // Counts saves from every instance of this hook, so the top bar and Settings share one guard.
  const inFlight = useIsMutating({ mutationKey: themeMutationKey }) > 0;
  const preference = currentPreference(me.data);
  // One save at a time: a second choice while one is in flight would race it, and the older
  // response could overwrite the newer one. Every theme control goes through this guard.
  function choose(theme: ThemePreference) {
    if (queryClient.isMutating({ mutationKey: themeMutationKey }) === 0 && theme !== preference) {
      save.mutate(theme);
    }
  }
  return {
    preference,
    saving: inFlight,
    choose,
    cycle: () => choose(nextThemePreference(preference)),
    saveFailed: save.isError,
    dismissFailure: save.reset,
  };
}

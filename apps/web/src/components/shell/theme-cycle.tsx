import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { haptic } from '../../lib/haptics';
import { type ThemePreference, themeCycleLabel } from '../../lib/theme';
import { iconPill } from '../../lib/ui-classes';
import { useThemePreference } from '../../lib/use-theme-preference';
import { useToast } from '../use-toast';

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const satisfies Record<
  ThemePreference,
  unknown
>;

/** Cycles system → light → dark and saves the choice to the account. */
export function ThemeCycle() {
  const { preference, cycle, saving, saveFailed, dismissFailure } = useThemePreference();
  const Icon = ICONS[preference];
  const label = themeCycleLabel(preference);
  const { show, toast } = useToast();
  // The always-mounted live region below announces the message; the hook state is just the trigger.
  useEffect(() => {
    if (!saveFailed) return;
    haptic('error');
    show('We could not save your theme. It is back to what it was.');
    dismissFailure();
  }, [saveFailed, show, dismissFailure]);
  return (
    <>
      <button
        type="button"
        onClick={cycle}
        aria-busy={saving}
        aria-label={label}
        title={label}
        className={`${iconPill} size-[42px]`}
      >
        <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {toast}
    </>
  );
}

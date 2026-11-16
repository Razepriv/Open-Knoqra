import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';

/** Round pill that flips light/dark, as in the Desk header. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? 'Switch to light' : 'Switch to dark';
  const Icon = theme === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className="flex size-[42px] shrink-0 cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
    >
      <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

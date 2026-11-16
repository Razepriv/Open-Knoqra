import { KEYPAD_KEYS } from '../../lib/dial';
import { focusRing } from '../../lib/ui-classes';

export interface KeypadProps {
  onPress: (key: string) => void;
  /** `dialer` is the large pad on the left; `compact` sits inside the live call panel for DTMF. */
  size?: 'dialer' | 'compact';
  disabled?: boolean;
  /** Names the group for assistive tech. */
  label: string;
}

const KEY_CLASS = {
  dialer: 'h-[58px] rounded-[20px]',
  compact: 'h-[46px] rounded-[16px]',
};

/** Twelve phone keys, each a real button with a spoken name ("Digit 1", "Star", "Pound"). */
export function Keypad({ onPress, size = 'dialer', disabled = false, label }: KeypadProps) {
  return (
    <fieldset className="m-0 grid min-w-0 grid-cols-3 gap-[10px] border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {KEYPAD_KEYS.map(({ key, label: name, letters }) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onPress(key)}
          className={`flex cursor-pointer flex-col items-center justify-center gap-[3px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)] transition-[transform,box-shadow] duration-[120ms] active:translate-y-px active:[box-shadow:var(--pressedShadow)] disabled:cursor-not-allowed disabled:opacity-50 ${KEY_CLASS[size]} ${focusRing}`}
        >
          {/* The name comes from content, not aria-label, so it never disagrees with what is shown. */}
          <span className="sr-only">{name}</span>
          <span
            aria-hidden="true"
            className={`font-[family-name:var(--font-display)] font-medium leading-none ${size === 'dialer' ? 'text-[23px]' : 'text-[19px]'}`}
          >
            {key}
          </span>
          {size === 'dialer' ? (
            <span
              aria-hidden="true"
              className="min-h-[10px] font-[family-name:var(--font-mono)] font-medium text-[9.5px] text-[color:var(--muted)] leading-none tracking-[.1em]"
            >
              {letters}
            </span>
          ) : null}
        </button>
      ))}
    </fieldset>
  );
}

import { TODAY_WIDGET_LABELS, type TodayWidget } from '@knoqra/core';
import { LayoutGrid, Plus } from 'lucide-react';
import { focusRing } from '../../lib/ui-classes';

export interface CustomizeToggleProps {
  editing: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

/** "Customize" turns on moving and hiding widgets; "Done" turns it off. */
export function CustomizeToggle({ editing, onToggle, disabled = false }: CustomizeToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={editing}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex h-[42px] shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-[color:var(--pillBorder)] px-[13px] font-medium text-[14px] leading-none [box-shadow:var(--pillShadow)] disabled:cursor-not-allowed disabled:opacity-50 ${
        editing
          ? 'bg-[color:var(--ink)] text-[color:var(--on-ink)]'
          : 'bg-[color:var(--pill)] text-[color:var(--text)]'
      } ${focusRing}`}
    >
      <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
      {editing ? 'Done' : 'Customize'}
    </button>
  );
}

export interface HiddenTrayProps {
  hidden: readonly TodayWidget[];
  onRestore: (widget: TodayWidget) => void;
}

/** Where hidden widgets wait. Each one comes back with a click. */
export function HiddenTray({ hidden, onRestore }: HiddenTrayProps) {
  if (hidden.length === 0) return null;
  return (
    <section
      data-tray
      aria-labelledby="hidden-widgets-title"
      className="flex min-h-[140px] flex-col items-center justify-center gap-[10px] rounded-[30px] border-2 border-[color:var(--muted)] border-dashed p-4 text-center opacity-90"
    >
      <h2
        id="hidden-widgets-title"
        className="font-medium text-[13px] text-[color:var(--muted)] leading-[1.3]"
      >
        Hidden widgets
      </h2>
      <ul className="flex flex-wrap justify-center gap-2">
        {hidden.map((widget) => (
          <li key={widget}>
            <button
              type="button"
              aria-label={`Show ${TODAY_WIDGET_LABELS[widget]}`}
              onClick={() => onRestore(widget)}
              className={`inline-flex h-8 cursor-pointer items-center gap-[6px] rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[12px] leading-none [box-shadow:var(--pillShadow)] ${focusRing}`}
            >
              <Plus size={13} strokeWidth={2} aria-hidden="true" />
              {TODAY_WIDGET_LABELS[widget]}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

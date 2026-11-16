import { TODAY_WIDGETS, type TodayWidget } from '@knoqra/core';
import { ArrowLeft, ArrowRight, EyeOff, GripVertical } from 'lucide-react';
import { type DragEvent, type ReactNode, useState } from 'react';
import { focusRing } from '../../lib/ui-classes';

/** What the page hands every widget so it can be moved, hidden and dragged in Customize mode. */
export interface WidgetControls {
  editing: boolean;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  onMove: (delta: -1 | 1) => void;
  onHide: () => void;
  /** Called on the widget something was dropped on, with the widget that was dragged. */
  onSwap: (dragged: TodayWidget) => void;
}

/** The Customize buttons in a widget header, as named in their `data-control`. */
export type WidgetControlName = 'earlier' | 'later' | 'hide';

export interface WidgetSlotProps {
  controls: WidgetControls;
  /** Shows a message in Today's one toast (a failed save, a finished focus block). */
  notify: (message: string) => void;
}

export type WidgetTone = 'light' | 'dark';

const DRAG_TYPE = 'application/x-knoqra-widget';

const tones: Record<WidgetTone, { surface: string; control: string; title: string }> = {
  light: {
    surface:
      'border-[color:var(--panelBorder)] bg-[image:var(--panel)] text-[color:var(--text)] [box-shadow:var(--panelShadow)]',
    control:
      'border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)]',
    title: 'text-[color:var(--muted)]',
  },
  dark: {
    surface:
      'border-[color:var(--panelBorder)] bg-[image:var(--streak-panel)] text-[color:var(--streak-text)] [box-shadow:var(--streak-shadow)]',
    control: 'border-[color:var(--streak-line)] bg-transparent text-[color:var(--streak-text)]',
    title: 'text-[color:var(--streak-muted)]',
  },
};

/** The mono pill that sits at the right of a widget header ("16 WEEKS", "GOAL 6"). */
export function eyebrowClass(tone: WidgetTone): string {
  const color =
    tone === 'dark'
      ? 'border-[color:var(--streak-line)] text-[color:var(--streak-soft)]'
      : 'border-[color:var(--pillBorder)] text-[color:var(--muted)]';
  return `inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full border px-[9px] font-[family-name:var(--font-mono)] font-medium text-[11px] uppercase leading-none tracking-[.02em] ${color}`;
}

function isWidget(value: string): value is TodayWidget {
  return (TODAY_WIDGETS as readonly string[]).includes(value);
}

export interface WidgetFrameProps {
  widget: TodayWidget;
  label: string;
  controls: WidgetControls;
  tone?: WidgetTone;
  /** Shown instead of the label as the visible header text (the label still names the region). */
  heading?: ReactNode;
  /** Right side of the header: a pill, a link, a stepper. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * One Today widget: a named region with its header. In Customize mode it gains a grip (drag it onto
 * another widget to swap them), buttons to move it earlier or later and one to hide it.
 */
export function WidgetFrame({
  widget,
  label,
  controls,
  tone = 'light',
  heading,
  aside,
  children,
  className = '',
}: WidgetFrameProps) {
  const { editing } = controls;
  const [dropTarget, setDropTarget] = useState(false);
  const look = tones[tone];

  function onDragStart(event: DragEvent<HTMLElement>) {
    event.dataTransfer.setData(DRAG_TYPE, widget);
    event.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!editing || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(true);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    setDropTarget(false);
    const dragged = event.dataTransfer.getData(DRAG_TYPE);
    if (!editing || !isWidget(dragged) || dragged === widget) return;
    event.preventDefault();
    controls.onSwap(dragged);
  }

  const outline = editing
    ? `outline-2 outline-offset-[3px] outline-dashed ${dropTarget ? 'outline-[color:var(--line)]' : 'outline-[color:var(--accent)]'}`
    : '';
  const controlButton = `flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full border disabled:cursor-not-allowed disabled:opacity-40 ${look.control} ${focusRing}`;

  return (
    <section
      aria-label={label}
      data-widget={widget}
      draggable={editing}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDragEnd={() => setDropTarget(false)}
      onDrop={onDrop}
      className={`flex min-w-0 flex-col gap-[14px] rounded-[30px] border px-5 py-[18px] ${look.surface} ${outline} ${className}`}
    >
      <div className="flex min-h-[30px] items-center gap-2">
        {editing ? (
          <GripVertical
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`shrink-0 cursor-grab ${look.title}`}
          />
        ) : null}
        <h2 className="min-w-0 truncate font-[family-name:var(--font-display)] font-medium text-[18px] leading-none">
          {heading ?? label}
        </h2>
        <span className="flex-1" />
        {editing ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={`Move ${label} earlier`}
              data-control="earlier"
              disabled={!controls.canMoveEarlier}
              onClick={() => controls.onMove(-1)}
              className={controlButton}
            >
              <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Move ${label} later`}
              data-control="later"
              disabled={!controls.canMoveLater}
              onClick={() => controls.onMove(1)}
              className={controlButton}
            >
              <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Hide ${label}`}
              data-control="hide"
              onClick={controls.onHide}
              className={controlButton}
            >
              <EyeOff size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        {aside}
      </div>
      {children}
    </section>
  );
}

export interface PanelErrorProps {
  message: string;
  onRetry: () => void;
  tone?: WidgetTone;
}

/** A panel that could not load: says so plainly and offers a retry. */
export function PanelError({ message, onRetry, tone = 'light' }: PanelErrorProps) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-start justify-center gap-3 py-2">
      <p className="text-[13.5px] leading-[1.45]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className={`inline-flex h-[34px] cursor-pointer items-center rounded-full border px-3 font-medium text-[13px] leading-none ${tones[tone].control} ${focusRing}`}
      >
        Try again
      </button>
    </div>
  );
}

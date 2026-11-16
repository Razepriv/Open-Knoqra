import { type DayKey, dayKeyIn, startOfWeek, TODAY_WIDGETS, type TodayWidget } from '@knoqra/core';
import { Reveal } from '@knoqra/ui';
import { createFileRoute } from '@tanstack/react-router';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { PageRibbon } from '../../components/shell/ribbon';
import {
  GreetingSkeleton,
  TodaySkeleton,
  WidgetsSkeleton,
} from '../../components/skeletons/today-skeleton';
import { ConsistencyWidget } from '../../components/today/consistency-widget';
import { CustomizeToggle, HiddenTray } from '../../components/today/customize-bar';
import { FocusWidget } from '../../components/today/focus-widget';
import { OttoWidget } from '../../components/today/otto-widget';
import { UpNextWidget } from '../../components/today/up-next-widget';
import { WeekGrid } from '../../components/today/week-grid';
import type {
  WidgetControlName,
  WidgetControls,
  WidgetSlotProps,
} from '../../components/today/widget-frame';
import { WorkspaceRibbon } from '../../components/today/workspace-ribbon';
import { useToast } from '../../components/use-toast';
import { useMe } from '../../lib/api';
import { greeting } from '../../lib/greeting';
import { browserPlatform, commandKeyLabel } from '../../lib/platform';
import { useEffectiveTimeZone } from '../../lib/time-zone';
import {
  moveWidget,
  restoreWidget,
  swapWidgets,
  type TodayPrefsChanges,
  useTodayPrefs,
  useUpdateTodayPrefs,
  visibleWidgets,
} from '../../lib/today';
import { dateLine, hourIn } from '../../lib/today-format';
import { useNow } from '../../lib/use-now';

export const Route = createFileRoute('/_app/')({
  staticData: { title: 'Today' },
  pendingComponent: TodaySkeleton,
  component: Home,
});

/** Every Today widget by key. */
const WIDGETS: Record<TodayWidget, ComponentType<WidgetSlotProps>> = {
  streak: ConsistencyWidget,
  next: UpNextWidget,
  focus: FocusWidget,
  otto: OttoWidget,
};

const CLOCK_REFRESH_MS = 60_000;

function Home() {
  const { session } = Route.useRouteContext();
  const me = useMe();
  const timeZone = useEffectiveTimeZone();
  const now = useNow(CLOCK_REFRESH_MS);
  const today = dayKeyIn(now, timeZone);
  const currentStart = startOfWeek(today);
  // null follows the current week, so the grid moves on by itself after midnight on Sunday.
  const [pickedStart, setPickedStart] = useState<DayKey | null>(null);
  const [editing, setEditing] = useState(false);
  const [shortcut] = useState(() => commandKeyLabel(browserPlatform()));
  // One toast for the whole page, so messages from different widgets never pile up.
  const toast = useToast();
  const name = me.data?.user.name ?? session?.user.name ?? '';

  return (
    <>
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-wrap items-end gap-x-4 gap-y-3 px-2 pt-1">
          <div className="flex min-w-0 flex-col gap-[10px]">
            <p className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
              Today · {dateLine(today)}
            </p>
            <Reveal loading={me.isPending}>
              {me.isPending ? (
                <GreetingSkeleton label="Loading your workspace" />
              ) : (
                <h1 className="font-[family-name:var(--font-display)] text-[clamp(30px,3.6vw,44px)] leading-none tracking-[-0.03em]">
                  {greeting(name, hourIn(now, timeZone))}
                </h1>
              )}
            </Reveal>
          </div>
          <span className="flex-1" />
          <span
            title="Command palette"
            className="hidden h-[42px] items-center gap-2 rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-[family-name:var(--font-mono)] font-medium text-[12px] text-[color:var(--muted)] leading-none [box-shadow:var(--pillShadow)] sm:inline-flex"
          >
            <kbd className="font-[inherit] text-[color:var(--text)]">{shortcut}</kbd>
            to jump
          </span>
          <CustomizeToggle editing={editing} onToggle={() => setEditing((on) => !on)} />
        </header>
        <WeekGrid
          start={pickedStart ?? currentStart}
          currentStart={currentStart}
          today={today}
          onStartChange={(start) => setPickedStart(start === currentStart ? null : start)}
        />
        <TodayWidgets editing={editing} notify={toast.show} />
      </div>
      {toast.toast}
      <PageRibbon label="Workspace">
        <WorkspaceRibbon />
      </PageRibbon>
    </>
  );
}

type FocusTarget = { widget: TodayWidget; controls: readonly WidgetControlName[] } | { tray: true };

/** Puts keyboard focus on the first enabled control named in `target`, after the layout changed. */
function placeFocus(root: HTMLElement, target: FocusTarget): void {
  if ('tray' in target) {
    root.querySelector<HTMLButtonElement>('[data-tray] button')?.focus();
    return;
  }
  const frame = root.querySelector(`[data-widget="${target.widget}"]`);
  for (const name of target.controls) {
    const button = frame?.querySelector<HTMLButtonElement>(`button[data-control="${name}"]`);
    if (button && !button.disabled) {
      button.focus();
      return;
    }
  }
}

interface TodayWidgetsProps {
  editing: boolean;
  notify: (message: string) => void;
}

function TodayWidgets({ editing, notify }: TodayWidgetsProps) {
  const prefs = useTodayPrefs();
  const update = useUpdateTodayPrefs();
  const root = useRef<HTMLDivElement>(null);
  // Moving or hiding re-renders the widgets; focus follows once the new layout is on screen.
  const pendingFocus = useRef<{ target: FocusTarget; before: unknown } | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !root.current || prefs.data === pending.before) return;
    pendingFocus.current = null;
    placeFocus(root.current, pending.target);
  });

  if (prefs.isPending) {
    return <WidgetsSkeleton label="Loading your widgets" />;
  }
  // Without saved preferences the default layout still works; changes just are not offered.
  const order = prefs.data?.widgetOrder ?? [...TODAY_WIDGETS];
  const hidden = prefs.data?.hiddenWidgets ?? [];
  const visible = visibleWidgets(order, hidden);
  const stillHidden = order.filter((widget) => hidden.includes(widget));
  const fullOrder = [...visible, ...stillHidden];

  function save(changes: TodayPrefsChanges, focusAfter?: FocusTarget) {
    pendingFocus.current = focusAfter ? { target: focusAfter, before: prefs.data } : null;
    update.mutate(changes, {
      onError: () => {
        pendingFocus.current = null;
        notify('We could not save your layout. Try again.');
      },
    });
  }

  function hide(widget: TodayWidget, index: number) {
    const neighbour = visible[index + 1] ?? visible[index - 1];
    save(
      { hiddenWidgets: [...hidden, widget] },
      neighbour ? { widget: neighbour, controls: ['hide'] } : { tray: true },
    );
  }

  function restore(widget: TodayWidget) {
    const others = stillHidden.length > 1;
    save(
      restoreWidget(order, hidden, widget),
      others ? { tray: true } : { widget, controls: ['hide'] },
    );
  }

  function controlsFor(widget: TodayWidget, index: number): WidgetControls {
    return {
      editing: editing && prefs.isSuccess,
      canMoveEarlier: index > 0,
      canMoveLater: index < visible.length - 1,
      onMove: (delta) =>
        save(
          { widgetOrder: moveWidget(fullOrder, widget, delta) },
          { widget, controls: delta === -1 ? ['earlier', 'later'] : ['later', 'earlier'] },
        ),
      onHide: () => hide(widget, index),
      onSwap: (dragged) => save({ widgetOrder: swapWidgets(fullOrder, dragged, widget) }),
    };
  }

  return (
    <div ref={root} className="@container">
      <div className="grid @min-[1240px]:grid-cols-4 @min-[640px]:grid-cols-2 grid-cols-1 gap-4">
        {visible.map((widget, index) => {
          const Widget = WIDGETS[widget];
          return <Widget key={widget} controls={controlsFor(widget, index)} notify={notify} />;
        })}
        <HiddenTray hidden={stillHidden} onRestore={restore} />
      </div>
    </div>
  );
}

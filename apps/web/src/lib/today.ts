import type { components } from '@knoqra/api-client';
import {
  canonicalTimeZone,
  type DayKey,
  normalizeWidgetOrder,
  type TodayWidget,
} from '@knoqra/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed, useMe } from './api';
import { useEffectiveTimeZone } from './time-zone';

export type TodaySummary = components['schemas']['TodaySummary'];
export type TodayWeek = components['schemas']['TodayWeek'];
export type TodayWeekRow = TodayWeek['rows'][number];
export type ActivityEntry = components['schemas']['ActivityEntry'];
export type TodayPrefs = components['schemas']['TodayPrefs'];
export type TodayPrefsChanges = components['schemas']['UpdateTodayPrefs'];

// Everything sits under ['today'], so task changes (which invalidate ['today']) refresh Today.
export const todayKey = ['today'] as const;
const summaryKey = (timeZone: string) => [...todayKey, 'summary', timeZone] as const;
const weekKey = (timeZone: string, start: DayKey) =>
  [...todayKey, 'week', timeZone, start] as const;
export const todayPrefsKey = [...todayKey, 'prefs'] as const;
const PREFS_MUTATION_KEY = ['today-prefs-update'] as const;

/**
 * The zone that decides "today", and whether it is settled: until the account has loaded, the
 * saved zone is unknown, so asking would fetch the browser zone's day only to fetch again.
 */
function useTodayZone(): { timeZone: string; ready: boolean } {
  const me = useMe();
  // An old alias the browser reports (Asia/Calcutta) is sent under its current name.
  const timeZone = canonicalTimeZone(useEffectiveTimeZone());
  return { timeZone, ready: !me.isPending };
}

/** Streak, heatmap, goal and due counts for today in the user's zone. */
export function useTodaySummary() {
  const { timeZone, ready } = useTodayZone();
  return useQuery({
    queryKey: summaryKey(timeZone),
    enabled: ready,
    // Outcomes are logged all over the desk (notes, calls, tasks), so Today asks again on every visit.
    staleTime: 0,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/today', { params: { query: { tz: timeZone } }, signal }),
        'Could not load today.',
      ),
  });
}

/** The week grid starting on Monday `start`. */
export function useWeek(start: DayKey) {
  const { timeZone, ready } = useTodayZone();
  return useQuery({
    queryKey: weekKey(timeZone, start),
    enabled: ready,
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/today/week', {
          params: { query: { tz: timeZone, start } },
          signal,
        }),
        'Could not load this week.',
      ),
  });
}

export function useTodayPrefs() {
  return useQuery({
    queryKey: todayPrefsKey,
    queryFn: async ({ signal }) => {
      const prefs = throwIfFailed(
        await api.GET('/api/v1/me/today-prefs', { signal }),
        'Could not load your layout.',
      );
      return { ...prefs, widgetOrder: normalizeWidgetOrder(prefs.widgetOrder) };
    },
  });
}

/** Saves layout and goal changes. The screen changes at once and goes back if the save fails. */
export function useUpdateTodayPrefs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: PREFS_MUTATION_KEY,
    mutationFn: async (changes: TodayPrefsChanges) =>
      throwIfFailed(
        await api.PATCH('/api/v1/me/today-prefs', { body: changes }),
        'Could not save your layout.',
      ),
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: todayPrefsKey });
      const previous = queryClient.getQueryData<TodayPrefs>(todayPrefsKey);
      if (previous)
        queryClient.setQueryData<TodayPrefs>(todayPrefsKey, { ...previous, ...changes });
      return { previous };
    },
    onError: (_error, _changes, context) => {
      if (context?.previous) queryClient.setQueryData(todayPrefsKey, context.previous);
      void queryClient.invalidateQueries({ queryKey: todayPrefsKey });
    },
    onSuccess: (saved) => {
      // A later change still in flight would be undone for a moment by this older answer.
      if (queryClient.isMutating({ mutationKey: PREFS_MUTATION_KEY }) <= 1) {
        queryClient.setQueryData(todayPrefsKey, saved);
      }
    },
    onSettled: (_saved, _error, changes) => {
      if (changes.dailyGoal !== undefined) {
        void queryClient.invalidateQueries({ queryKey: [...todayKey, 'summary'] });
      }
    },
  });
}

/** `order` with `widget` moved one place earlier (-1) or later (1). A new array; edges stay put. */
export function moveWidget(
  order: readonly TodayWidget[],
  widget: TodayWidget,
  delta: -1 | 1,
): TodayWidget[] {
  const from = order.indexOf(widget);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return [...order];
  return order.map((item, index) => {
    if (index === from) return order[to] ?? item;
    if (index === to) return widget;
    return item;
  });
}

/** `order` with `a` and `b` trading places. A new array; unchanged if either is missing. */
export function swapWidgets(
  order: readonly TodayWidget[],
  a: TodayWidget,
  b: TodayWidget,
): TodayWidget[] {
  if (!order.includes(a) || !order.includes(b)) return [...order];
  return order.map((item) => {
    if (item === a) return b;
    if (item === b) return a;
    return item;
  });
}

/** The widgets on screen, in the saved order. */
export function visibleWidgets(
  order: readonly TodayWidget[],
  hidden: readonly TodayWidget[],
): TodayWidget[] {
  return order.filter((widget) => !hidden.includes(widget));
}

/** Shows `widget` again, placed after the widgets already on screen. */
export function restoreWidget(
  order: readonly TodayWidget[],
  hidden: readonly TodayWidget[],
  widget: TodayWidget,
): { widgetOrder: TodayWidget[]; hiddenWidgets: TodayWidget[] } {
  const hiddenWidgets = hidden.filter((item) => item !== widget);
  const visible = visibleWidgets(order, hidden);
  const stillHidden = order.filter((item) => hiddenWidgets.includes(item));
  return { widgetOrder: [...visible, widget, ...stillHidden], hiddenWidgets };
}

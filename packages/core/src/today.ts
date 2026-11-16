export const TODAY_WIDGETS = ['streak', 'next', 'focus', 'otto'] as const;
export type TodayWidget = (typeof TODAY_WIDGETS)[number];

export const TODAY_WIDGET_LABELS: Record<TodayWidget, string> = {
  streak: 'Consistency',
  next: 'Up next',
  focus: "Today's focus",
  otto: 'Otto',
};

export const DAILY_GOAL_MIN = 1;
export const DAILY_GOAL_MAX = 12;
export const DAILY_GOAL_DEFAULT = 6;

function isTodayWidget(value: string): value is TodayWidget {
  return (TODAY_WIDGETS as readonly string[]).includes(value);
}

/** Keeps known widgets once each, in the given order, then appends any missing. */
export function normalizeWidgetOrder(order: readonly string[]): TodayWidget[] {
  const seen = new Set<TodayWidget>();
  for (const item of order) if (isTodayWidget(item)) seen.add(item);
  for (const widget of TODAY_WIDGETS) seen.add(widget);
  return [...seen];
}

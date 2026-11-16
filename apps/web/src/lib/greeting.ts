export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** 5–11 morning, 12–17 afternoon, any other hour evening (local time). */
export function partOfDay(hour: number): PartOfDay {
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 17) return 'afternoon';
  return 'evening';
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** "Good morning, Ana". Drops the name when there is none. */
export function greeting(name: string, hour: number): string {
  const first = firstName(name);
  const salutation = `Good ${partOfDay(hour)}`;
  return first ? `${salutation}, ${first}` : salutation;
}

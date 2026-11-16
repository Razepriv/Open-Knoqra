/**
 * Layout classes shared by a real component and its loading outline, so the two cannot drift
 * (like shellLayout for the Desk frame). The web app's AuthLayout and ContactRow use these, and so
 * do SkeletonAuth and SkeletonRow.
 */

/** The two-panel auth page: the promise on the left, the form card on the right. */
export const authLayout = {
  grid: 'grid flex-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]',
  hero: 'relative isolate flex flex-col gap-10 overflow-hidden p-6 sm:p-9',
  heroTop: 'flex items-center justify-between gap-4',
  heroCopy: 'flex flex-1 flex-col justify-end gap-6',
  formPanel: 'flex flex-col justify-center p-6 sm:p-10',
  formColumn: 'mx-auto flex w-full max-w-[400px] flex-col gap-7',
  formHeading: 'flex flex-col gap-3',
} as const;

/** A pill card row in a list (a contact): 36px avatar, padding and border give 56px. */
export const listRow = {
  frame:
    'flex items-center gap-[10px] rounded-[18px] border border-[color:var(--pillBorder)] px-[10px] py-[9px]',
  rest: 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]',
  pressed: 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]',
} as const;

/**
 * Layout classes the contact pages share with their loading outlines (components/skeletons), so a
 * page and its outline cannot drift apart.
 */

/** Contact 360: the narrow contact list beside the contact, from 1024px up. */
export const contact360Layout = {
  grid: 'grid min-h-0 flex-1 gap-4 lg:grid-cols-[272px_minmax(0,1fr)]',
  listColumn:
    'hidden min-h-0 lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100dvh_-_2_*_var(--page-pad,0px)_-_6rem)] lg:flex-col lg:self-start',
  view: 'flex min-w-0 flex-col gap-4',
} as const;

/**
 * Contact 360's header: avatar, the name column, and the channel actions. From 640px the actions
 * are a column at the right (Call 40px, WhatsApp and SMS 38px, at least 130px wide, 8px apart);
 * below that they wrap in a row under the rest.
 */
export const profileHeaderLayout = {
  panel: 'flex flex-wrap items-center gap-[18px] p-5 sm:px-[22px]',
  main: 'flex min-w-[220px] flex-1 flex-col gap-2',
  titleRow: 'flex items-start justify-between gap-3',
  chips: 'flex flex-wrap gap-[6px]',
  actions:
    'order-last flex basis-full flex-wrap items-center gap-2 sm:order-none sm:basis-auto sm:flex-col sm:items-stretch sm:self-start',
  /** Every channel pill's width; Call is 40px tall, the others 38px. */
  actionMinWidth: 130,
} as const;

/** The contact list panel, full (Contacts page) or compact (beside Contact 360). */
export function contactListPanel(compact: boolean): string {
  return `flex min-h-0 flex-1 flex-col ${compact ? 'gap-3 p-3 pt-4' : 'gap-5 p-6 sm:p-8'}`;
}

/** The search field at the top of that panel: 40px, radius 20, a flat cell fill, no shadow. */
export function contactSearchBox(compact: boolean): string {
  return `flex h-10 items-center gap-2 rounded-[20px] bg-[color:var(--cell)] px-[14px] ${compact ? 'mx-1' : ''}`;
}

/** The list of contact rows inside that panel. */
export const contactRowsList = 'flex flex-col gap-[6px] p-1';

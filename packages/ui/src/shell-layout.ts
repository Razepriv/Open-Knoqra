/**
 * The Desk frame's sizes, shared by the web app's AppShell and the SkeletonShell placeholder so the
 * two cannot drift apart. Three panes at 1280px and up (the ribbon column), one column with the
 * rail as a bottom bar below 1024px.
 */
export const shellLayout = {
  /** Rail beside the page column at 1024px and up; below that one column, rail last. */
  frame: 'flex flex-1 flex-col gap-4 lg:grid lg:grid-cols-[68px_minmax(0,1fr)]',
  /**
   * The pill rail: a bar along the bottom below 1024px; from 1024px up a sticky 68px column one
   * viewport tall (less the page and shell padding), so it never stretches with the page as content
   * loads (a layout-shift fix) and stays in view on scroll. --page-pad is 0 in a browser and the
   * desktop frame's inset otherwise (apps/web styles.css); the shell padding is 1rem from 1024px.
   */
  rail: 'sticky bottom-2 z-20 order-last flex items-center justify-between gap-1 rounded-[28px] border border-[color:var(--panelBorder)] bg-[image:var(--panel)] p-2 [box-shadow:var(--panelShadow)] lg:top-[calc(var(--page-pad,0px)_+_1rem)] lg:bottom-auto lg:order-none lg:h-[calc(100dvh_-_2_*_var(--page-pad,0px)_-_2rem)] lg:flex-col lg:overflow-y-auto lg:justify-start lg:gap-[10px] lg:self-start lg:rounded-[34px] lg:px-0 lg:py-3',
  /**
   * The ribbon column's aside, without its display (the app shows it with `flex`, the skeleton only
   * from 1280px): sticky and as tall as the visible column (viewport less the page and shell padding,
   * the 62px top bar and its 16px gap), not stretched to the page.
   */
  ribbonAside:
    'sticky top-[calc(var(--page-pad,0px)_+_1rem)] h-[calc(100dvh_-_2_*_var(--page-pad,0px)_-_110px)] min-w-0 flex-col self-start',
  /** Top bar above the page, then the page (and ribbon). */
  column: 'flex min-w-0 flex-1 flex-col gap-4',
  topBar:
    'flex h-[62px] shrink-0 items-center gap-2 rounded-[26px] border border-[color:var(--panelBorder)] bg-[image:var(--panel)] px-[10px] [box-shadow:var(--panelShadow)]',
  /** The page and, when shown, the 316px ribbon. */
  content: 'grid min-h-0 flex-1 gap-4',
  oneColumn: 'grid-cols-[minmax(0,1fr)]',
  withRibbon: 'grid-cols-[minmax(0,1fr)_316px]',
  /** The ribbon column from 1280px up, for markup that cannot ask a media query (the skeleton). */
  withRibbonWide: 'xl:grid-cols-[minmax(0,1fr)_316px]',
  main: 'flex min-w-0 flex-col',
} as const;

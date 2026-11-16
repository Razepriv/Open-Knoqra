/** Visible keyboard focus, shared by every interactive element. */
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2';

/** The round pill used for icon buttons in the top bar and rail. */
export const iconPill = `flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)] ${focusRing}`;

/** A text pill button, as used for secondary actions. */
export const textPill = `inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[13px] text-[color:var(--text)] leading-none [box-shadow:var(--pillShadow)] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

/** Floating menu and popover surface. */
export const menuSurface =
  'z-50 min-w-[220px] rounded-[22px] border border-[color:var(--panelBorder)] bg-[color:var(--shell)] p-2 text-[color:var(--text)] [box-shadow:var(--panelShadow)]';

export const menuItem = `flex cursor-pointer items-center gap-2 rounded-[14px] px-3 py-2.5 font-medium text-[14px] outline-none data-[highlighted]:bg-[color:var(--pressed)] data-[disabled]:opacity-50 ${focusRing}`;

/** The dimmed backdrop behind a dialog or drawer. */
export const dialogOverlay = 'fixed inset-0 z-40 bg-[color:var(--page)] opacity-70';

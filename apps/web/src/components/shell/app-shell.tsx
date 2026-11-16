import { shellLayout } from '@knoqra/ui';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { isPaletteShortcut, useGlobalShortcut } from '../../lib/use-global-shortcut';
import { useMediaQuery, WIDE_QUERY } from '../../lib/use-media-query';
import { OfflineBanner } from '../states/offline-banner';
import { CommandPalette } from './command-palette';
import { ContextDrawer } from './context-drawer';
import { NavRail } from './nav-rail';
import { RibbonContext } from './ribbon';
import { TopBar } from './top-bar';
import type { UserMenuProps } from './user-menu';

export interface AppShellProps {
  user: UserMenuProps;
  children: ReactNode;
}

/**
 * The Desk frame: rail, top bar and the page, with an optional context ribbon (see PageRibbon).
 * Three panes at 1280px and up. At 1024–1279px the ribbon opens in a drawer from the top bar.
 * Below 1024px it is one column and the rail becomes a bottom bar.
 */
export function AppShell({ user, children }: AppShellProps) {
  const wide = useMediaQuery(WIDE_QUERY);
  const [ribbonLabel, setRibbonLabel] = useState<string | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const contextButton = useRef<HTMLButtonElement>(null);
  useGlobalShortcut(isPaletteShortcut, () => setPaletteOpen((open) => !open));

  // The drawer only exists below 1280px. Leaving it open would bring it back on the way down.
  useEffect(() => {
    if (wide) setDrawerOpen(false);
  }, [wide]);

  const registry = useMemo(() => ({ target, register: setRibbonLabel }), [target]);
  const inlineLabel = wide ? ribbonLabel : null;
  const drawerLabel = wide ? null : ribbonLabel;

  return (
    <RibbonContext.Provider value={registry}>
      <div className={shellLayout.frame}>
        <a
          href="#main"
          className="sr-only rounded-full bg-[color:var(--accent)] px-4 py-2 font-semibold text-[color:var(--on-accent)] text-sm focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
        >
          Skip to content
        </a>
        <NavRail />
        <div className={shellLayout.column}>
          <TopBar
            user={user}
            onOpenContext={drawerLabel ? () => setDrawerOpen(true) : undefined}
            contextButtonRef={contextButton}
          />
          <OfflineBanner />
          <div
            className={`${shellLayout.content} ${
              inlineLabel ? shellLayout.withRibbon : shellLayout.oneColumn
            }`}
          >
            <main
              id="main"
              tabIndex={-1}
              className={`${shellLayout.main} outline-none focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-4`}
            >
              {children}
            </main>
            {inlineLabel ? (
              // Sticky and as tall as the visible column (viewport less the page and shell padding,
              // the 62px top bar and its 16px gap), not stretched to the page: content at the
              // bottom of the ribbon would otherwise move down when the page grows after load.
              // Children may shrink (min-h-0), so each ribbon panel scrolls inside its own rounded
              // edges. The column does not clip, which would cut off the panels' drop shadow.
              <aside aria-label={inlineLabel} className={`flex ${shellLayout.ribbonAside}`}>
                <div ref={setTarget} className="flex min-h-0 flex-1 flex-col [&>*]:min-h-0" />
              </aside>
            ) : null}
          </div>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        {drawerLabel ? (
          <ContextDrawer
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            label={drawerLabel}
            targetRef={setTarget}
            returnFocusTo={contextButton}
          />
        ) : null}
      </div>
    </RibbonContext.Provider>
  );
}

import type { RouteComponent } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import type { Me } from './lib/api';
import type { CallPreflight } from './lib/calls';
import type { UsageSummary } from './lib/usage';

/** A page under the signed-in shell, added as a code-based route (extension-pages.ts). */
export interface DeskPage {
  /** The path under the shell, without a leading slash (`rates` serves `/rates`). */
  path: string;
  /** Shown in the top bar and the document title. */
  title: string;
  component: RouteComponent;
  /** The page's own loading outline (the skeleton rule): required, like every route's. */
  pendingComponent: RouteComponent;
}

/**
 * What an edition adds to the open-source Desk. Every slot is optional; the core renders its own
 * default where an extension leaves one empty. Core code never imports an extension: the loader
 * below finds it, and finds nothing in the open-source tree. See EDITIONS.md.
 */
export interface DeskExtension {
  name: string;
  pages?: readonly DeskPage[];
  /** Extra sections at the end of Settings' right-hand column. */
  SettingsSections?: ComponentType<{ me: Me }>;
  /**
   * The wallet panel's funding buttons for owners and admins. `addCredit` is the core's own
   * button (hand-recorded credit), to render as is when the extension has nothing to add.
   */
  WalletFunding?: ComponentType<{ addCredit: ReactNode; onAddCredit: () => void }>;
  /** A line about the destination's price in the dial check, when the preflight carries one. */
  DialRateNote?: ComponentType<{ rate: NonNullable<CallPreflight['rate']> }>;
  /** Extra lines under the Spend chart's legend on the Usage page. */
  SpendNotes?: ComponentType<{ summary: UsageSummary }>;
}

/**
 * KNOQRA Cloud keeps its Desk code in `apps/web/pro`, which the open-source tree does not have. An
 * eager glob that matches nothing is an empty object, so the public build has no extensions and no
 * reference to the folder survives in its bundle.
 */
const found = import.meta.glob<{ deskExtension: DeskExtension }>('../pro/index.tsx', {
  eager: true,
});

/** The extensions this build carries, in a stable order. Read at render time, never at import. */
export function deskExtensions(): readonly DeskExtension[] {
  return Object.keys(found)
    .sort()
    .map((key) => found[key]?.deskExtension)
    .filter((extension): extension is DeskExtension => extension !== undefined);
}

/** The first extension component filling `slot`, or null for the core's default. */
export function deskSlot<K extends keyof DeskExtension>(
  slot: K,
): NonNullable<DeskExtension[K]> | null {
  for (const extension of deskExtensions()) {
    const value = extension[slot];
    if (value) return value as NonNullable<DeskExtension[K]>;
  }
  return null;
}

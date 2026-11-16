import { Reveal, Skeleton, shellLayout } from '@knoqra/ui';
import { useMatches } from '@tanstack/react-router';
import { PanelRight } from 'lucide-react';
import { type Ref, useEffect } from 'react';
import { useMe } from '../../lib/api';
import { iconPill } from '../../lib/ui-classes';
import { BrandMark } from '../brand';
import { NotificationsBell } from './notifications-bell';
import { ThemeCycle } from './theme-cycle';
import { UserMenu, type UserMenuProps } from './user-menu';

export interface TopBarProps {
  user: UserMenuProps;
  /** Set when the page has a ribbon that is not showing beside it. */
  onOpenContext?: (() => void) | undefined;
  /** Points at the Open context button so the drawer can hand focus back to it. */
  contextButtonRef?: Ref<HTMLButtonElement>;
}

/** Workspace name in IBM Plex Mono caps. The DOM text keeps its natural case; CSS sets the caps. */
function WorkspaceChip() {
  const me = useMe();
  return (
    <span className="hidden h-[42px] min-w-0 max-w-[260px] items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-[family-name:var(--font-mono)] font-medium text-[12px] uppercase leading-none tracking-[.04em] [box-shadow:var(--pillShadow)] sm:flex">
      <Reveal loading={me.isPending}>
        {me.isPending ? (
          <Skeleton width={110} height={12} label="Loading workspace" />
        ) : me.data ? (
          <span className="block truncate">{me.data.organization.name}</span>
        ) : (
          <span className="block truncate text-[color:var(--danger-text)]">
            Workspace unavailable
          </span>
        )}
      </Reveal>
    </span>
  );
}

/** Page title, workspace label, theme toggle and the account menu. */
export function TopBar({ user, onOpenContext, contextButtonRef }: TopBarProps) {
  const title = useMatches({ select: (ms) => ms.at(-1)?.staticData?.title });

  useEffect(() => {
    document.title = title ? `${title} · KNOQRA` : 'KNOQRA';
    // Signing out leaves the shell: the auth pages set no title of their own.
    return () => {
      document.title = 'KNOQRA';
    };
  }, [title]);

  return (
    <header className={shellLayout.topBar}>
      <span className="lg:hidden">
        <BrandMark size={42} />
      </span>
      <p className="min-w-0 truncate px-2 font-[family-name:var(--font-display)] text-[22px] leading-none tracking-[-0.02em]">
        {title}
      </p>
      <span className="flex-1" />
      <WorkspaceChip />
      {onOpenContext ? (
        <button
          type="button"
          ref={contextButtonRef}
          onClick={onOpenContext}
          aria-label="Open context"
          title="Open context"
          className={`${iconPill} size-[42px]`}
        >
          <PanelRight size={17} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
      <NotificationsBell />
      <ThemeCycle />
      <UserMenu {...user} />
    </header>
  );
}

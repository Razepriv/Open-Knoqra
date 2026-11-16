import { Avatar } from '@knoqra/ui';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut, Settings } from 'lucide-react';
import { useState } from 'react';
import { authClient } from '../../lib/auth';
import { copy } from '../../lib/auth-errors';
import { haptic } from '../../lib/haptics';
import { SETTINGS_PATH } from '../../lib/nav-items';
import { applyTheme } from '../../lib/theme';
import { focusRing, menuItem, menuSurface } from '../../lib/ui-classes';
import { useToast } from '../use-toast';

export interface UserMenuProps {
  name: string;
  email: string;
}

/** Account menu: who is signed in, Settings and Sign out. */
export function UserMenu({ name, email }: UserMenuProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { show, toast } = useToast();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    if (signingOut) return;
    haptic('warning');
    setSigningOut(true);
    let ok = false;
    try {
      const { error } = await authClient.signOut();
      ok = !error;
    } catch {
      ok = false; // Network failure: the session cookie is still set, so stay here.
    }
    if (!ok) {
      setSigningOut(false);
      haptic('error');
      show(copy.signOutFailed);
      return;
    }
    try {
      queryClient.clear();
      // The next person on this browser should start from the system theme, not this account's.
      applyTheme('system');
      await navigate({ to: '/sign-in' });
    } catch {
      setSigningOut(false);
      haptic('error');
      show(copy.signOutFailed);
    }
  }

  return (
    <>
      {/* Not modal: a modal menu marks the whole page aria-hidden while its buttons stay focusable. */}
      <Menu.Root modal={false}>
        <Menu.Trigger
          className={`flex size-[42px] shrink-0 cursor-pointer items-center justify-center rounded-full ${focusRing}`}
        >
          <Avatar name={name} tone="ink" size={42} />
          {/* The name comes from content, so it never disagrees with the initials shown. */}
          <span className="sr-only">Account menu</span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content align="end" sideOffset={10} className={menuSurface}>
            <Menu.Label className="flex flex-col gap-1 px-3 pt-2 pb-3">
              <span className="font-semibold text-[14px] leading-tight">{name}</span>
              <span className="break-all text-[12px] text-[color:var(--muted)]">{email}</span>
            </Menu.Label>
            <Menu.Separator className="mx-2 mb-1 h-px bg-[color:var(--panelBorder)]" />
            <Menu.Item asChild>
              <Link to={SETTINGS_PATH} className={menuItem}>
                <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
                Settings
              </Link>
            </Menu.Item>
            <Menu.Item
              disabled={signingOut}
              aria-busy={signingOut}
              onSelect={signOut}
              className={menuItem}
            >
              <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {toast}
    </>
  );
}

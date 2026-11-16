import { shellLayout } from '@knoqra/ui';
import { Link, useRouterState } from '@tanstack/react-router';
import { isNavActive, NAV_ITEMS, type NavItem, SETTINGS_ITEM } from '../../lib/nav-items';
import { focusRing } from '../../lib/ui-classes';
import { BrandMark } from '../brand';

function RailLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isNavActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      aria-label={item.label}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      className={`flex size-11 shrink-0 items-center justify-center rounded-full border border-[color:var(--pillBorder)] text-[color:var(--text)] sm:size-[46px] ${focusRing} ${
        active
          ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
          : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]'
      }`}
    >
      <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
    </Link>
  );
}

/**
 * The Desk's pill rail: a column at 1024px and up, a bar along the bottom below that.
 *
 * At 1024px and up the column is sticky and one viewport tall (the page's 24px padding plus the
 * shell's 16px, top and bottom), not stretched to the page: its spacers would otherwise push the
 * lower links down whenever the page grows after load, a layout shift on every long page.
 */
export function NavRail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Primary" className={shellLayout.rail}>
      <span className="hidden lg:flex">
        <BrandMark />
      </span>
      <span className="hidden flex-1 lg:block" />
      {NAV_ITEMS.map((item) => (
        <RailLink key={item.to} item={item} pathname={pathname} />
      ))}
      <span className="hidden flex-1 lg:block" />
      <RailLink item={SETTINGS_ITEM} pathname={pathname} />
    </nav>
  );
}

import { Panel } from '@knoqra/ui';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
});

/**
 * The page around the shell canvas. In a browser the canvas fills the window on the shell colour.
 * In the desktop app (html[data-shell="framed"], see index.html) it floats as a rounded frame on the
 * page colour, inset by --page-pad (styles.css).
 */
function RootLayout() {
  return (
    <div className="min-h-dvh bg-[color:var(--shell)] p-[var(--page-pad)] transition-colors duration-[var(--dur-theme)] [[data-shell=framed]_&]:bg-[color:var(--page)]">
      <div className="flex min-h-[calc(100dvh_-_2_*_var(--page-pad))] w-full flex-col gap-4 bg-[color:var(--shell)] p-3 text-[color:var(--text)] transition-colors duration-[var(--dur-theme)] sm:p-4 [[data-shell=framed]_&]:mx-auto [[data-shell=framed]_&]:max-w-[1440px] [[data-shell=framed]_&]:rounded-[28px] [[data-shell=framed]_&]:[box-shadow:var(--shadow-shell)] sm:[[data-shell=framed]_&]:rounded-[36px]">
        <Outlet />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <Panel className="flex flex-1 flex-col items-start justify-center gap-4 p-9">
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]">
        Not found
      </p>
      <h1 className="font-[family-name:var(--font-display)] text-[40px] leading-none tracking-[-0.03em]">
        There is nothing at this address.
      </h1>
      <Link to="/" className="text-[15px] underline underline-offset-4">
        Back to your desk
      </Link>
    </Panel>
  );
}

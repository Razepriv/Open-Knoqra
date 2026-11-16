import { type AnyRoute, createRoute } from '@tanstack/react-router';
import { type DeskPage, deskExtensions } from './extensions';
import { Route as ShellRoute } from './routes/_app';

/**
 * Adds every extension page as a code-based route under the signed-in shell (`/_app`), next to the
 * file routes in routeTree.gen.ts. Runs once, before the router is created. With no extensions
 * (the open-source build) the tree is returned untouched.
 */
export function withExtensionPages<T extends AnyRoute>(
  tree: T,
  pages: readonly DeskPage[] = deskExtensions().flatMap((e) => e.pages ?? []),
  shell: AnyRoute = ShellRoute as unknown as AnyRoute,
): T {
  if (pages.length === 0) return tree;
  const extra = pages.map((page) =>
    createRoute({
      getParentRoute: () => shell,
      path: page.path,
      staticData: { title: page.title },
      component: page.component,
      pendingComponent: page.pendingComponent,
    }),
  );
  const current = shell.children;
  const existing: AnyRoute[] = Array.isArray(current)
    ? current
    : Object.values((current ?? {}) as Record<string, AnyRoute>);
  shell.addChildren([...existing, ...extra]);
  return tree;
}

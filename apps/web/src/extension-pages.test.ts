// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { withExtensionPages } from './extension-pages';
import { deskExtensions } from './extensions';

const Nothing = () => null;

function tree() {
  const root = createRootRoute();
  const shell = createRoute({ getParentRoute: () => root, id: '_app' });
  const home = createRoute({ getParentRoute: () => shell, path: '/' });
  shell.addChildren([home]);
  root.addChildren([shell]);
  return { root, shell };
}

describe('withExtensionPages', () => {
  it('leaves the tree alone without pages', () => {
    const { root, shell } = tree();
    expect(withExtensionPages(root, [], shell)).toBe(root);
    expect(shell.children).toHaveLength(1);
  });

  it('adds each page under the shell, next to its file routes', async () => {
    const { root, shell } = tree();
    const page = { path: 'rates', title: 'Rates', component: Nothing, pendingComponent: Nothing };
    const router = createRouter({
      routeTree: withExtensionPages(root, [page], shell),
      history: createMemoryHistory({ initialEntries: ['/rates'] }),
    });
    await router.load();
    const ids = router.state.matches.map((m) => m.routeId);
    expect(ids).toEqual(['__root__', '/_app', '/_app/rates']);
    expect(router.state.matches.at(-1)?.staticData).toMatchObject({ title: 'Rates' });
  });

  it('finds the pages this build carries', () => {
    // KNOQRA Cloud carries apps/web/pro; the open-source build carries none.
    for (const extension of deskExtensions()) {
      for (const page of extension.pages ?? []) expect(page.path).not.toMatch(/^\//);
    }
  });
});

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './components/app-error-boundary';
import { RouteErrorScreen } from './components/crash-screen';
import { RoutePending } from './components/skeletons/shell-skeleton';
import { withExtensionPages } from './extension-pages';
import { createUnauthorizedHandler, isUnauthorized } from './lib/api';
import { preloadFonts } from './lib/fonts';
import { startObservability } from './lib/observability/start';
import { routeTree } from './routeTree.gen';
import './styles.css';

// Fetch every webfont face now, so a face first used by late content cannot reflow the page.
preloadFonts(document.fonts);

// The router needs the query client and the 401 handler needs the router, so bind it afterwards.
let onUnauthorized: (error: unknown) => void = () => {};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => onUnauthorized(error) }),
  mutationCache: new MutationCache({ onError: (error) => onUnauthorized(error) }),
  defaultOptions: {
    // A 401 will not fix itself on retry; anything else gets one more try. 'always': offline, a
    // query fails (so its panel can say "offline") instead of pausing, and a save fails at once
    // instead of waiting behind a disabled button. One retry each keeps an offline page quiet.
    queries: {
      retry: (count, error) => !isUnauthorized(error) && count < 1,
      staleTime: 30_000,
      networkMode: 'always',
    },
    mutations: { networkMode: 'always' },
  },
});

const router = createRouter({
  // Edition pages (extensions.ts) join the file routes before the router reads the tree.
  routeTree: withExtensionPages(routeTree),
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPendingMs: 300,
  // Every pending route shows its page's outline: the auth or shell frame chosen by the path.
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteErrorScreen,
});

onUnauthorized = createUnauthorizedHandler(router, queryClient);
startObservability(router);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('index.html is missing the #root element');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <RouterProvider router={router} />
      </AppErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);

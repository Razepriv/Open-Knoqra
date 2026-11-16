/**
 * The only module that imports `@sentry/react` at runtime, and only through `import()` from
 * sentry.ts. Re-exporting just what KNOQRA uses keeps the lazy chunk free of Replay, rrweb and
 * Feedback: a dynamic import of the package itself would keep its whole namespace.
 */
export {
  type Breadcrumb,
  type BrowserOptions,
  captureException,
  init,
  tanstackRouterBrowserTracingIntegration,
} from '@sentry/react';

/**
 * The only module that imports `posthog-js` at runtime, and only through `import()` from
 * analytics.ts. Only the default instance is re-exported, so analytics.ts holds that instance and
 * never the package namespace.
 */
export { default as posthog } from 'posthog-js/dist/module.slim.no-external';

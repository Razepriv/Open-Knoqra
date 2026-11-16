import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption, type ProxyOptions } from 'vite';
import { sentryUploadConfig } from './sentry-upload.ts';

/**
 * Dev and preview proxy to `wrangler dev` (apps/api). `changeOrigin: false` keeps the browser's
 * Host and Origin headers unchanged: Better Auth only trusts BETTER_AUTH_URL
 * (http://localhost:5173 in dev), so the API must see the origin the browser actually used.
 */
const webPort = Number(process.env.KNOQRA_WEB_PORT || 5173);
const apiPort = Number(process.env.KNOQRA_API_PORT || 8787);
const apiProxy: Record<string, ProxyOptions> = {
  // `ws: true` also proxies the realtime WebSocket upgrade (/api/v1/realtime).
  '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false, ws: true },
};

/**
 * Source maps exist only in the deploy build (all of SENTRY_AUTH_TOKEN, SENTRY_ORG and
 * SENTRY_PROJECT set): `hidden` maps (no sourceMappingURL comment), uploaded to Sentry and then
 * deleted from dist/. Locally there are no maps, no plugin and no upload.
 */
const upload = sentryUploadConfig(process.env);
const sentryUpload: PluginOption[] = upload
  ? [
      sentryVitePlugin({
        org: upload.org,
        project: upload.project,
        authToken: upload.authToken,
        ...(upload.release ? { release: { name: upload.release } } : {}),
        sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
        telemetry: false,
      }),
    ]
  : [];

export default defineConfig({
  // The router plugin must run before the React plugin; the Sentry plugin runs last.
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    ...sentryUpload,
  ],
  // three is only reached through Otto's lazy `import('./otto-scene')`. Pre-bundling it up front
  // stops the dev server from finding it mid-session and reloading every open page.
  optimizeDeps: { include: ['three'] },
  server: { port: webPort, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, proxy: apiProxy },
  build: {
    manifest: true,
    sourcemap: upload ? 'hidden' : false,
    // Otto's three.js chunk is about 505 kB and only loads when his head is on screen.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      // Better Auth's shared env helper builds a frozen object of server-only getters
      // (BETTER_AUTH_SECRET, ...) that the browser never reads. Marking Object.freeze pure lets
      // tree-shaking drop it, so secret names stay out of the bundle (scripts/check-no-secrets.mjs).
      treeshake: { manualPureFunctions: ['Object.freeze'] },
    },
  },
});

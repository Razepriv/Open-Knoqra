// Runs Lighthouse (desktop preset) against a page of the Chromium that Playwright launched with
// --remote-debugging-port, so the Lighthouse tab shares that browser's signed-in cookies.
import { createServer } from 'node:net';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';

type LhResult = NonNullable<Awaited<ReturnType<typeof lighthouse>>>['lhr'];

export async function runLighthouse(url: string, port: number): Promise<LhResult> {
  const result = await lighthouse(
    url,
    { port, output: 'json', logLevel: 'error', disableStorageReset: true },
    desktopConfig,
  );
  if (result === undefined) throw new Error(`Lighthouse returned no result for ${url}`);
  return result.lhr;
}

/** A free TCP port on loopback, for Chromium's remote debugging. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

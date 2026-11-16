import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { app, openApiDocConfig } from '../src/app';
import type { AppEnv } from '../src/lib/context';

const out = (relative: string) =>
  fileURLToPath(new URL(`../../../packages/api-client/${relative}`, import.meta.url));

async function emit(api: OpenAPIHono<AppEnv>, outFile: string): Promise<void> {
  const doc = api.getOpenAPI31Document(openApiDocConfig);
  // Guard against drift: the file must match what the live route serves.
  const live = await api.request('/api/openapi.json', undefined, { APP_ENV: 'test' });
  if (JSON.stringify(await live.json()) !== JSON.stringify(doc)) {
    throw new Error('emitted OpenAPI document differs from /api/openapi.json');
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(`wrote ${outFile}\n`);
}

// The open-source core API: the document behind @knoqra/api-client.
await emit(app, out('openapi.json'));

// Another edition (KNOQRA Cloud keeps its code in pro/, absent from the open-source tree) writes its
// own document beside it. A variable specifier keeps the core typecheck free of that path.
const editionApp = fileURLToPath(new URL('../pro/src/app.ts', import.meta.url));
if (existsSync(editionApp)) {
  const { cloudApp } = (await import(editionApp)) as { cloudApp: OpenAPIHono<AppEnv> };
  await emit(cloudApp, out('pro/openapi.json'));
}

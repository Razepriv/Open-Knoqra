// Regenerates the client types from the emitted OpenAPI documents: the core document always, and an
// edition's document (KNOQRA Cloud keeps it in pro/, absent from the open-source tree) when present.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (input, output) =>
  execFileSync('pnpm', ['exec', 'openapi-typescript', input, '-o', output], {
    cwd: root,
    stdio: 'inherit',
  });

run('openapi.json', 'src/schema.d.ts');
if (existsSync(`${root}pro/openapi.json`)) run('pro/openapi.json', 'pro/schema.d.ts');

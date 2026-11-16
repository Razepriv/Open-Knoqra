#!/usr/bin/env node
// The self-host command: `pnpm knoqra setup` asks for your accounts and keys and saves them to
// .env.selfhost; `pnpm knoqra deploy [step]` sets up and deploys KNOQRA on your own Cloudflare
// account and Postgres. Both take --dry-run. See docs/self-host.md.
//
//   node scripts/knoqra/cli.mjs setup
//   node scripts/knoqra/cli.mjs deploy [all|db|cloudflare|config|api|secrets|web|status]
import { fileURLToPath } from 'node:url';
import { main } from './main.mjs';
import { createPostgres, loadPg } from './postgres.mjs';
import { createExec, createTtyPrompt } from './runtime.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { env } = process;
const color = Boolean(process.stdout.isTTY) && !env.NO_COLOR;

process.exitCode = await main(process.argv.slice(2), {
  root,
  // pnpm runs scripts from the repository root; INIT_CWD is where the user typed the command.
  cwd: env.INIT_CWD || process.cwd(),
  color,
  write: (text) => process.stdout.write(text),
  fetch: globalThis.fetch,
  createPrompt: () => createTtyPrompt({ color }),
  createExec: (secrets) => createExec({ secrets }),
  db: createPostgres(loadPg(root)),
});

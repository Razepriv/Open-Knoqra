// Argument parsing and command dispatch for `pnpm knoqra`. Every side effect comes in through
// `deps`, so tests drive it with fakes and no network, child process or terminal.
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runDeploy, STEPS } from './deploy.mjs';
import { readEnvFile, saveEnvValues } from './env-file.mjs';
import { runSetup } from './questions.mjs';
import { ENV_FILE_NAME, redact, SetupError, secretStrings } from './settings.mjs';

export const USAGE = `Usage: pnpm knoqra <command> [options]

Commands:
  setup               Ask for your accounts and keys, and save them to ${ENV_FILE_NAME}
  deploy [step]       Set up and deploy KNOQRA. Steps, in order:
                        all (default)  every step below
                        db             the app's database role and migrations
                        cloudflare     the Hyperdrive config and the queues
                        config         write apps/*/wrangler.selfhost.jsonc
                        api            deploy the API Worker
                        secrets        set the API Worker's secrets
                        web            build and deploy the Desk
                        status         show the URLs and check the API's health

Options:
  --dry-run           Show every step without changing anything or writing files
  --env-file <path>   Read settings from <path> instead of ${ENV_FILE_NAME}
  -h, --help          Show this help
`;

class UsageError extends Error {}

/** Parses the command line: { command, step, dryRun, envFile, help }. */
export function parseArgs(argv) {
  const parsed = { command: null, step: null, dryRun: false, envFile: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (arg === '--env-file') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new UsageError('--env-file needs a path.');
      parsed.envFile = value;
      i += 1;
    } else if (arg.startsWith('--env-file=')) parsed.envFile = arg.slice('--env-file='.length);
    else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new UsageError(`Too many arguments: ${positional.join(' ')}.`);
  [parsed.command = null, parsed.step = null] = positional;
  return parsed;
}

/**
 * Runs the CLI and returns the exit code.
 * @param {string[]} argv
 * @param {object} deps
 * @param {string} deps.root    the repository root
 * @param {string} deps.cwd     where relative --env-file paths start
 * @param {(text: string) => void} deps.write
 * @param {boolean} [deps.color]
 * @param {typeof fetch} deps.fetch
 * @param {() => { ask: Function, close?: Function }} deps.createPrompt
 * @param {(secrets: () => string[]) => Function} deps.createExec
 * @param {{ check: Function, ensureAppRole: Function }} deps.db
 * @param {(n: number) => Buffer} [deps.randomBytes]
 * @param {typeof import('node:fs')} [deps.fs]
 * @param {string} [deps.tmpDir]
 */
export async function main(argv, deps) {
  const { write } = deps;
  let values = {};
  try {
    const args = parseArgs(argv);
    if (args.help) {
      write(USAGE);
      return 0;
    }
    if (!args.command) throw new UsageError('Name a command.');
    const envPath = args.envFile ? resolve(deps.cwd, args.envFile) : join(deps.root, ENV_FILE_NAME);
    const shown = relative(deps.cwd, envPath);
    const envFileLabel = shown && !shown.startsWith('..') && !isAbsolute(shown) ? shown : envPath;

    if (args.command === 'setup') {
      if (args.step) throw new UsageError('setup takes no step.');
      const saved = readEnvFile(envPath);
      values = saved.values;
      const prompt = deps.createPrompt();
      try {
        await runSetup({
          values: saved.values,
          prompt,
          fetch: deps.fetch,
          checkPostgres: (url) => deps.db.check(url),
          randomBytes: deps.randomBytes,
          write,
          color: deps.color,
          dryRun: args.dryRun,
          envFileLabel,
          save: (next) => {
            values = next;
            if (!args.dryRun) saveEnvValues(envPath, next);
          },
        });
      } finally {
        prompt.close?.();
      }
      return 0;
    }

    if (args.command === 'deploy') {
      const step = args.step ?? 'all';
      if (step !== 'all' && !STEPS.includes(step)) {
        throw new UsageError(`Unknown step "${step}".`);
      }
      const saved = readEnvFile(envPath);
      if (!saved.exists) {
        throw new SetupError(`No settings file at ${envFileLabel}. Run: pnpm knoqra setup`);
      }
      values = saved.values;
      await runDeploy({
        step,
        values,
        root: deps.root,
        fetch: deps.fetch,
        exec: deps.createExec(() => secretStrings(values)),
        db: deps.db,
        write,
        color: deps.color,
        dryRun: args.dryRun,
        fs: deps.fs,
        tmpDir: deps.tmpDir,
      });
      return 0;
    }

    throw new UsageError(`Unknown command "${args.command}".`);
  } catch (error) {
    if (error instanceof UsageError) {
      write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    write(`\n  ✗ ${redact(message, secretStrings(values))}\n`);
    if (error?.step)
      write(`  Fix it, then run that step again: pnpm knoqra deploy ${error.step}\n`);
    return 1;
  }
}

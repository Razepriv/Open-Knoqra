// The real side effects behind the CLI: a terminal prompt with hidden input for secrets, and a
// child-process runner whose output is filtered so a secret value never reaches the terminal.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { redact } from './settings.mjs';

/**
 * A prompt over stdin/stdout. Secret answers are not echoed. Works with piped input too (one
 * answer per line). Ctrl+C exits.
 */
export function createTtyPrompt({ input = process.stdin, output = process.stdout, color } = {}) {
  let muted = false;
  const sink = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output: sink, terminal });
  rl.on('SIGINT', () => {
    output.write('\n');
    process.exit(130);
  });
  const lines = rl[Symbol.asyncIterator]();
  const dim = (text) => (color ? `\u001b[2m${text}\u001b[22m` : text);
  return {
    async ask({ label, secret = false, hint = '' }) {
      output.write(`  ${label}${hint ? ` ${dim(`(${hint})`)}` : ''}: `);
      muted = secret && terminal;
      const next = await lines.next();
      muted = false;
      if (secret && terminal) output.write(`${dim('(hidden)')}\n`);
      if (next.done) throw new Error('Input ended before setup finished.');
      return next.value;
    },
    close() {
      rl.close();
    },
  };
}

/** Passes text through `redact` line by line (a secret split across chunks is still caught). */
function redactingStream(target, secrets) {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk.toString();
      const end = pending.lastIndexOf('\n');
      if (end === -1) return;
      target.write(redact(pending.slice(0, end + 1), secrets));
      pending = pending.slice(end + 1);
    },
    flush() {
      if (pending) target.write(redact(pending, secrets));
      pending = '';
    },
  };
}

/**
 * Returns an exec function: runs a command with extra env vars, filtering its output through
 * `redact`, and rejects on a non-zero exit.
 */
export function createExec({ secrets = () => [] } = {}) {
  return (command, args, { cwd, env = {} }) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      const hidden = secrets();
      const out = redactingStream(process.stdout, hidden);
      const err = redactingStream(process.stderr, hidden);
      child.stdout.on('data', (chunk) => out.write(chunk));
      child.stderr.on('data', (chunk) => err.write(chunk));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        out.flush();
        err.flush();
        if (code === 0) resolve();
        else
          reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`}).`));
      });
    });
}

// Output helpers: perf scripts write with process.stdout/stderr, never console.

/** Writes one line to stdout. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Writes one line to stderr and exits 1. */
export function fail(line: string): never {
  process.stderr.write(`${line}\n`);
  process.exit(1);
}

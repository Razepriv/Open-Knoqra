import { describe, expect, it } from 'vitest';
import { ports, resolveTarget } from '../src/config';

const none = {} as NodeJS.ProcessEnv;

function value(argv: string[], env: NodeJS.ProcessEnv = none) {
  const r = resolveTarget(argv, env);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function error(argv: string[], env: NodeJS.ProcessEnv = none): string {
  const r = resolveTarget(argv, env);
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('resolveTarget', () => {
  it('builds both URLs from --database', () => {
    expect(value(['--database', 'knoqra_s9_perf'])).toEqual({
      database: 'knoqra_s9_perf',
      adminUrl: 'postgres://knoqra:knoqra@localhost:54329/knoqra_s9_perf',
      appUrl: 'postgres://knoqra_app:knoqra_app@localhost:54329/knoqra_s9_perf',
      force: false,
    });
  });

  it('refuses the protected databases', () => {
    expect(error(['--database', 'knoqra'])).toMatch(/refusing/);
    expect(error(['--database', 'knoqra_m1'])).toMatch(/refusing/);
  });

  it('refuses the protected databases even with --force', () => {
    expect(error(['--database', 'knoqra', '--force'])).toMatch(/refusing/);
    expect(error(['--database', 'knoqra_m1', '--force'])).toMatch(/refusing/);
    expect(
      error(['--force'], {
        PERF_DATABASE_URL: 'postgres://a:b@h:5432/knoqra',
      } as NodeJS.ProcessEnv),
    ).toMatch(/refusing/);
    expect(
      error(['--force'], {
        PERF_ADMIN_DATABASE_URL: 'postgres://a:b@h:5432/knoqra_m1',
      } as NodeJS.ProcessEnv),
    ).toMatch(/refusing/);
  });

  it('rejects --database that disagrees with a PERF_*_DATABASE_URL', () => {
    expect(
      error(['--database', 'x_perf'], {
        PERF_DATABASE_URL: 'postgres://a:b@h:5432/y_perf',
      } as NodeJS.ProcessEnv),
    ).toMatch(/--database x_perf does not match the database in PERF_DATABASE_URL \(y_perf\)/);
  });

  it('refuses a name without "perf" unless --force', () => {
    expect(error(['--database', 'knoqra_s9'])).toMatch(/refusing/);
    const forced = value(['--database', 'knoqra_s9', '--force']);
    expect(forced.database).toBe('knoqra_s9');
    expect(forced.force).toBe(true);
  });

  it('asks for --database when nothing names a database', () => {
    expect(error([])).toMatch(/pass --database <name>/);
  });

  it('lets PERF_*_DATABASE_URL override the URLs and guards the parsed name', () => {
    const env = {
      PERF_DATABASE_URL: 'postgres://a:b@db.example.test:5432/other_perf',
      PERF_ADMIN_DATABASE_URL: 'postgres://c:d@db.example.test:5432/other_perf',
    } as NodeJS.ProcessEnv;
    const target = value(['--database', 'other_perf'], env);
    expect(target.appUrl).toBe(env.PERF_DATABASE_URL);
    expect(target.adminUrl).toBe(env.PERF_ADMIN_DATABASE_URL);
    expect(
      error([], { PERF_DATABASE_URL: 'postgres://a:b@h:5432/knoqra_s9' } as NodeJS.ProcessEnv),
    ).toMatch(/refusing/);
    expect(
      error(['--database', 'x_perf'], {
        PERF_ADMIN_DATABASE_URL: 'postgres://a:b@h:5432/knoqra',
      } as NodeJS.ProcessEnv),
    ).toMatch(/refusing/);
  });
});

describe('ports', () => {
  it('reads the web port override and derives the origin', () => {
    const p = ports({ KNOQRA_WEB_PORT: '5279' } as NodeJS.ProcessEnv);
    expect(p.webOrigin).toBe('http://localhost:5279');
    expect(p.apiPort).toBe(8787);
  });

  it('rejects a privileged port', () => {
    expect(() => ports({ KNOQRA_WEB_PORT: '80' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('rejects PERF_DATABASE_URL and PERF_ADMIN_DATABASE_URL naming different databases', () => {
    const env = {
      PERF_DATABASE_URL: 'postgres://a:b@h:5432/x_perf',
      PERF_ADMIN_DATABASE_URL: 'postgres://a:b@h:5432/some_other_db',
    } as NodeJS.ProcessEnv;
    const message =
      'PERF_DATABASE_URL (x_perf) and PERF_ADMIN_DATABASE_URL (some_other_db) must name the same database';
    expect(error([], env)).toBe(message);
    expect(error(['--force'], env)).toBe(message);
    expect(error(['--force', '--reset'], env)).toBe(message);
  });

  it('rejects a PERF_*_DATABASE_URL with no database path, with and without --force', () => {
    for (const variable of ['PERF_DATABASE_URL', 'PERF_ADMIN_DATABASE_URL']) {
      for (const url of ['postgres://knoqra:knoqra@localhost:54329', 'postgres://u:p@h:5432/']) {
        const env = { [variable]: url } as NodeJS.ProcessEnv;
        const message = `${variable} must name a database (.../<name>)`;
        expect(error(['--database', 'x_perf'], env)).toBe(message);
        expect(error(['--database', 'x_perf', '--force'], env)).toBe(message);
        expect(error(['--force', '--reset'], env)).toBe(message);
      }
    }
  });
});

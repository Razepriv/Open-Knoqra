import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  changedValues,
  ENV_HEADER,
  parseEnv,
  readEnvFile,
  saveEnvValues,
  updateEnvText,
} from './env-file.mjs';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'knoqra-env-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs fn while capturing everything written to stdout and stderr. */
function captureStdio(fn) {
  const written = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() || true : true;
  };
  process.stderr.write = process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return written.join('');
}

describe('parseEnv', () => {
  it('reads keys, skips comments and blank lines, keeps = in values, last wins', () => {
    const text = [
      '# comment',
      '',
      'A=1',
      'URL=postgresql://u:p@h/db?sslmode=require',
      'export B = two words ',
      'Q="quoted\\nvalue"',
      "S='single'",
      'A=2',
    ].join('\n');
    assert.deepEqual(parseEnv(text), {
      A: '2',
      URL: 'postgresql://u:p@h/db?sslmode=require',
      B: 'two words',
      Q: 'quoted\nvalue',
      S: 'single',
    });
  });
});

describe('updateEnvText', () => {
  it('replaces in place, keeps comments and other keys, appends new keys', () => {
    const text = '# keep me\nA=1\nOTHER=x\n\nB=2\n';
    assert.equal(
      updateEnvText(text, { A: 'one', C: '3' }),
      '# keep me\nA=one\nOTHER=x\n\nB=2\nC=3\n',
    );
  });

  it('removes a key set to an empty value, and drops duplicate lines of an updated key', () => {
    const text = 'A=1\nB=2\nA=3\n';
    assert.equal(updateEnvText(text, { A: '9', B: '' }), 'A=9\n');
  });

  it('quotes values that would not survive a raw line, and reads them back', () => {
    const values = { LEAD: ' x', NL: 'a\nb', Q: '"q"', SENDER: 'KNOQRA <no-reply@example.com>' };
    const text = updateEnvText('', values);
    assert.match(text, /^SENDER=KNOQRA <no-reply@example\.com>$/m);
    assert.deepEqual(parseEnv(text), values);
  });
});

describe('changedValues', () => {
  it('lists changed, added and removed keys', () => {
    assert.deepEqual(changedValues({ A: '1', B: '2', C: '3' }, { A: '1', B: '9', D: '4' }), {
      B: '9',
      C: '',
      D: '4',
    });
  });
});

describe('saveEnvValues', () => {
  it('creates the file with a header and mode 600', () => {
    const path = join(tempDir(), '.env.selfhost');
    saveEnvValues(path, { A: '1' });
    const text = readFileSync(path, 'utf8');
    assert.ok(text.startsWith(ENV_HEADER));
    assert.match(text, /^A=1$/m);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('keeps keys and comments added by hand, and tightens the mode', () => {
    const path = join(tempDir(), '.env.selfhost');
    writeFileSync(path, '# mine\nCUSTOM=keep\nA=1\n', { mode: 0o644 });
    const { values } = readEnvFile(path);
    saveEnvValues(path, { ...values, A: '2', B: 'new' });
    assert.equal(readFileSync(path, 'utf8'), '# mine\nCUSTOM=keep\nA=2\nB=new\n');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('writes nothing to stdout or stderr, so secret values are never shown', () => {
    const path = join(tempDir(), '.env.selfhost');
    const output = captureStdio(() => {
      saveEnvValues(path, { CLOUDFLARE_API_TOKEN: 'token-SECRET-value' });
      saveEnvValues(path, { CLOUDFLARE_API_TOKEN: 'token-SECRET-other' });
    });
    assert.equal(output, '');
    assert.equal(readEnvFile(path).values.CLOUDFLARE_API_TOKEN, 'token-SECRET-other');
  });

  it('does not rewrite an unchanged file', () => {
    const path = join(tempDir(), '.env.selfhost');
    saveEnvValues(path, { A: '1' });
    assert.equal(saveEnvValues(path, { A: '1' }), false);
  });

  it('reads a missing file as empty', () => {
    assert.deepEqual(readEnvFile(join(tempDir(), 'missing')), {
      exists: false,
      text: '',
      values: {},
    });
  });
});

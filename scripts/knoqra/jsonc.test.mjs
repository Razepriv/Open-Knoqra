import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseJsonc, stripJsonc } from './jsonc.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('parseJsonc', () => {
  it('removes line and block comments outside strings', () => {
    const text = `{
      // a line comment
      "a": 1, /* a block
      comment */ "b": [1, 2]
    }`;
    assert.deepEqual(parseJsonc(text), { a: 1, b: [1, 2] });
  });

  it('keeps comment-like text inside strings', () => {
    const text = `{
      "url": "https://example.com/path", // real comment
      "glob": "/* not a comment */",
      "quoted": "say \\"hi\\" // still the string",
      "path": "C:\\\\dir\\\\" /* ends after an escaped backslash */
    }`;
    assert.deepEqual(parseJsonc(text), {
      url: 'https://example.com/path',
      glob: '/* not a comment */',
      quoted: 'say "hi" // still the string',
      path: 'C:\\dir\\',
    });
  });

  it('drops trailing commas in objects and arrays, but not inside strings', () => {
    const text = '{ "a": [1, 2, ], "b": { "c": ",]" , }, }';
    assert.deepEqual(parseJsonc(text), { a: [1, 2], b: { c: ',]' } });
  });

  it('drops a trailing comma followed by a comment', () => {
    assert.deepEqual(parseJsonc('{ "a": 1, // last\n }'), { a: 1 });
  });

  it('throws on an unterminated block comment', () => {
    assert.throws(() => stripJsonc('{ /* open'), SyntaxError);
  });

  it('parses the repository base wrangler configs', () => {
    for (const app of ['api', 'web']) {
      const config = parseJsonc(readFileSync(`${root}apps/${app}/wrangler.jsonc`, 'utf8'));
      assert.equal(typeof config.main, 'string');
      assert.equal(typeof config.compatibility_date, 'string');
    }
    const api = parseJsonc(readFileSync(`${root}apps/api/wrangler.jsonc`, 'utf8'));
    assert.match(api.$schema, /^\.\/node_modules\//);
  });
});

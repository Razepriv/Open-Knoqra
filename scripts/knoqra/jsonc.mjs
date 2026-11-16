// A small JSONC reader for the wrangler.jsonc files: `//` and `/* */` comments and trailing commas
// are removed outside strings, then the result goes to JSON.parse. Plain Node, no dependencies.

/** Returns the JSON text left after removing comments and trailing commas outside strings. */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('JSONC: unterminated /* comment');
      i = end + 2;
      out += ' ';
    } else if (char === '}' || char === ']') {
      out = out.replace(/,(\s*)$/, '$1');
      out += char;
      i += 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** Parses JSONC text (JSON with comments and trailing commas). */
export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

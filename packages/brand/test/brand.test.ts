import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BRAND_NAME,
  BRAND_URL,
  COPYRIGHT_NOTICE,
  legalLinks,
  logoAssets,
  POWERED_BY,
  SOURCE_URL,
} from '../src/index';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

const svgFiles = listFiles(join(root, 'assets')).filter((file) => file.endsWith('.svg'));

describe('brand constants', () => {
  it('exports the product name', () => {
    expect(BRAND_NAME).toBe('KNOQRA');
  });

  it('exports the attribution and the legal notice links', () => {
    expect(POWERED_BY).toBe('Powered by KNOQRA');
    expect(COPYRIGHT_NOTICE).toContain(BRAND_NAME);
    for (const url of [BRAND_URL, SOURCE_URL, ...Object.values(legalLinks)]) {
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it('links to legal documents that exist in the repository', () => {
    const repoRoot = resolve(root, '../..');
    for (const [name, url] of Object.entries(legalLinks)) {
      if (url === SOURCE_URL) continue;
      const file = url.slice(`${SOURCE_URL}/blob/main/`.length);
      expect(existsSync(join(repoRoot, file)), `${name} -> ${file}`).toBe(true);
    }
  });

  it('maps every variant to a file that exists', () => {
    const entries = Object.entries(logoAssets);
    expect(entries.length).toBeGreaterThanOrEqual(13);
    for (const [name, path] of entries) {
      expect(existsSync(join(root, path)), `${name} -> ${path}`).toBe(true);
    }
  });

  it('ships the favicon pair and the otto stills', () => {
    for (const file of [
      'assets/icons/knoqra-favicon.svg',
      'assets/icons/knoqra-favicon-light.svg',
      'assets/mascot/otto-avatar.png',
      'assets/mascot/otto-head-cut.png',
      'reference/otto-head.js',
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });
});

describe('svg safety', () => {
  it('finds svg files to scan', () => {
    expect(svgFiles.length).toBeGreaterThanOrEqual(20);
  });

  it.each(svgFiles.map((file) => [relative(root, file).split(sep).join('/'), file]))(
    '%s has no script, handlers, javascript: URLs, external references or metadata',
    (_name, file) => {
      const svg = readFileSync(file as string, 'utf8');
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg).not.toMatch(/javascript:/i);
      expect(svg).not.toMatch(/<foreignObject/i);
      expect(svg).not.toMatch(/(?:xlink:)?href\s*=\s*["'](?!#)/i);
      expect(svg).not.toMatch(/url\(\s*["']?(?!#)/i);
      expect(svg).not.toMatch(/<metadata/i);
      expect(svg).not.toMatch(/c2pa/i);
    },
  );
});

/** True when source code imports (statically or dynamically) anything under a reference/ folder. */
function importsReference(source: string): boolean {
  return /(?:from|import)\s*\(?\s*['"][^'"]*reference(?:\/|['"])/.test(source);
}

describe('reference source', () => {
  it('detects an import of reference/ in source text', () => {
    expect(importsReference("import { x } from '../reference/otto-head.js';")).toBe(true);
    expect(importsReference("const m = await import('../reference/otto-head.js');")).toBe(true);
    expect(importsReference("export * from '../reference';")).toBe(true);
    expect(importsReference("import { BRAND_NAME } from './brand';")).toBe(false);
  });

  it('is not imported by any file under src/', () => {
    const sources = listFiles(join(root, 'src')).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(importsReference(readFileSync(file, 'utf8')), relative(root, file)).toBe(false);
    }
  });

  it('is not reachable from the package entry', () => {
    const entry = readFileSync(join(root, 'src/index.ts'), 'utf8');
    expect(entry).not.toMatch(/reference/);
    expect(entry).not.toMatch(/otto-head\.js/);
    expect(entry).not.toMatch(/^\s*(import|export)\s.*from\s/m);
  });

  it('is excluded from the exports map', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    for (const target of Object.values(pkg.exports)) {
      expect(target).not.toMatch(/reference/);
    }
  });
});

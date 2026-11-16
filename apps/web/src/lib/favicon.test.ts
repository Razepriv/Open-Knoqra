import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

const indexHtml = read('../../index.html');
const iconLinks = indexHtml.match(/<link[^>]*rel="icon"[^>]*>/g) ?? [];

describe('favicons', () => {
  it('starts with an unconditional icon, for browsers that ignore media on icons', () => {
    const first = iconLinks[0] ?? '';
    expect(first).toContain('href="/favicon.svg"');
    expect(first).toContain('type="image/svg+xml"');
    expect(first).not.toContain('media=');
  });

  it.each([
    [
      '/favicon.svg',
      'light',
      '../../public/favicon.svg',
      '@knoqra/brand/assets/icons/knoqra-favicon.svg',
    ],
    [
      '/favicon-light.svg',
      'dark',
      '../../public/favicon-light.svg',
      '@knoqra/brand/assets/icons/knoqra-favicon-light.svg',
    ],
  ])('links %s for %s browser chrome', (href, scheme, publicFile, brandAsset) => {
    const link = iconLinks.find(
      (tag) => tag.includes(`href="${href}"`) && tag.includes('prefers-color-scheme'),
    );
    expect(link, `${href} media link in index.html`).toBeDefined();
    expect(link).toContain('type="image/svg+xml"');
    expect(link).toContain(`media="(prefers-color-scheme: ${scheme})"`);

    const brandFile = new URL(
      `../../../../packages/brand/assets/icons/${brandAsset.split('/').pop()}`,
      import.meta.url,
    );
    expect(read(publicFile)).toBe(readFileSync(brandFile, 'utf8'));
  });
});

// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_URL, legalLinks } from '@knoqra/brand';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PoweredBy } from './powered-by';
import { AboutSection } from './settings/about-section';

/** The attribution ADDITIONAL-TERMS.md requires: a visible link that names KNOQRA. */
function attribution() {
  return screen.getByRole('link', { name: 'Powered by KNOQRA (opens in a new tab)' });
}

describe('PoweredBy', () => {
  afterEach(cleanup);

  it('renders a visible "Powered by KNOQRA" link to the project', () => {
    render(<PoweredBy />);
    const link = attribution();
    expect(link.textContent).toContain('Powered by KNOQRA');
    expect(link.getAttribute('href')).toBe(BRAND_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('aria-hidden')).toBeNull();
    expect(link.className).not.toMatch(/\b(sr-only|hidden|invisible|opacity-0)\b/);
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Source text of a file under src/, for checks on where a component is placed. */
const source = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('where the attribution appears', () => {
  it('is on every screen built on AuthLayout, including sign-in and sign-up', () => {
    expect(source('components/auth-layout.tsx')).toMatch(/<PoweredBy\s*\/>/);
    for (const route of ['sign-in', 'sign-up']) {
      expect(source(`routes/${route}.tsx`), route).toMatch(/<AuthLayout\b/);
    }
  });

  it('is in the About section of Settings', () => {
    expect(source('routes/_app/settings.tsx')).toMatch(/<AboutSection\s*\/>/);
  });
});

describe('AboutSection', () => {
  afterEach(cleanup);

  it('shows the attribution and the legal notices under an About heading', () => {
    render(<AboutSection />);
    const region = screen.getByRole('region', { name: 'About' });
    expect(within(region).getByRole('link', { name: /^Powered by KNOQRA/ })).toBeTruthy();
    expect(region.textContent).toContain('Copyright ©');
    expect(region.textContent).toContain('GNU Affero General Public License');
    expect(region.textContent).toContain('no warranty');
  });

  it('links to the license, the additional terms, the trademark policy and the source', () => {
    render(<AboutSection />);
    const list = screen.getByRole('list', { name: 'Legal documents' });
    const hrefs = within(list)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      legalLinks.license,
      legalLinks.additionalTerms,
      legalLinks.trademarks,
      legalLinks.source,
    ]);
  });
});

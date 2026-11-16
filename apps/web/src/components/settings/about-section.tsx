import { COPYRIGHT_NOTICE, legalLinks } from '@knoqra/brand';
import { ExternalLink } from 'lucide-react';
import { focusRing } from '../../lib/ui-classes';
import { PoweredBy } from '../powered-by';
import { SettingsSection } from './section';

export const ABOUT_SECTION = {
  id: 'about',
  title: 'About',
  description: 'The software behind this workspace, its license and where to find its source.',
} as const;

const LEGAL_LINKS = [
  { href: legalLinks.license, label: 'License (GNU AGPL v3)' },
  { href: legalLinks.additionalTerms, label: 'Additional terms' },
  { href: legalLinks.trademarks, label: 'Trademark policy' },
  { href: legalLinks.source, label: 'Source code' },
] as const;

/**
 * The Desk's Appropriate Legal Notices (AGPL sections 0 and 5(d)) and its offer of the source
 * (section 13). ADDITIONAL-TERMS.md requires them and the attribution to stay visible here.
 */
export function AboutSection() {
  return (
    <SettingsSection {...ABOUT_SECTION}>
      <div className="flex flex-col gap-4 text-[14px] leading-relaxed">
        <PoweredBy size="regular" />
        <p>{COPYRIGHT_NOTICE}</p>
        <p className="max-w-[64ch] text-[color:var(--muted)]">
          KNOQRA is free software: you can share and change it under the GNU Affero General Public
          License, version 3, and the additional terms that come with it. It comes with no warranty,
          to the extent the law allows. The KNOQRA name, logo and Otto are trademarks and are not
          covered by that license.
        </p>
        <ul aria-label="Legal documents" className="flex flex-wrap gap-x-5 gap-y-2">
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1.5 rounded-sm underline underline-offset-4 ${focusRing}`}
              >
                {link.label}
                <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />{' '}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </SettingsSection>
  );
}

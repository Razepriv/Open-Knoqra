import { BRAND_NAME, BRAND_URL } from '@knoqra/brand';
import { focusRing } from '../lib/ui-classes';

/**
 * The "Powered by KNOQRA" attribution. ADDITIONAL-TERMS.md (AGPL section 7(b)) requires it to stay
 * visible wherever the Desk shows it: the sign-in and sign-up screens and Settings, About.
 * Removing or hiding it needs a commercial white-label license (TRADEMARKS.md).
 */
export function PoweredBy({ size = 'small' }: { size?: 'small' | 'regular' }) {
  return (
    <a
      href={BRAND_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`self-start rounded-sm text-[color:var(--muted)] underline-offset-4 hover:underline ${
        size === 'small' ? 'text-[12px]' : 'text-[14px]'
      } ${focusRing}`}
    >
      Powered by <span className="font-semibold text-[color:var(--text)]">{BRAND_NAME}</span>{' '}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

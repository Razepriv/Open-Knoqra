/** Product name as written in UI copy and document titles. */
export const BRAND_NAME = 'KNOQRA';

/**
 * The attribution every KNOQRA interface keeps visible. ADDITIONAL-TERMS.md (AGPL section 7(b))
 * requires it; removing or hiding it needs a commercial white-label license (TRADEMARKS.md).
 */
export const POWERED_BY = `Powered by ${BRAND_NAME}`;

/** Where the attribution links: the KNOQRA project's home. */
export const BRAND_URL = 'https://knoqra.app';

/**
 * The public source of this program. AGPL section 13 asks a network service to offer its users
 * the source it runs, so a modified deployment points this at its own modified source.
 */
export const SOURCE_URL = 'https://github.com/Razepriv/Open-Knoqra';

/** The copyright line shown with the legal notices in each interface. */
export const COPYRIGHT_NOTICE = 'Copyright © 2026 the KNOQRA authors';

/** The legal documents each interface links to from its notices (AGPL "Appropriate Legal Notices"). */
export const legalLinks = {
  license: `${SOURCE_URL}/blob/main/LICENSE`,
  additionalTerms: `${SOURCE_URL}/blob/main/ADDITIONAL-TERMS.md`,
  trademarks: `${SOURCE_URL}/blob/main/TRADEMARKS.md`,
  source: SOURCE_URL,
} as const;

/**
 * Asset path for each logo, wordmark and icon variant, relative to this package's root.
 * Import the file itself through the `@knoqra/brand/assets/*` export, for example
 * `@knoqra/brand/assets/logo/knoqra-mark-ink.svg`.
 */
export const logoAssets = {
  'mark-2c-night': 'assets/logo/knoqra-mark-2c-night.svg',
  'mark-black': 'assets/logo/knoqra-mark-black.svg',
  'mark-citron': 'assets/logo/knoqra-mark-citron.svg',
  'mark-ink': 'assets/logo/knoqra-mark-ink.svg',
  'mark-paper': 'assets/logo/knoqra-mark-paper.svg',
  'mark-white': 'assets/logo/knoqra-mark-white.svg',
  'wordmark-2c-night': 'assets/logo/knoqra-wordmark-2c-night.svg',
  'wordmark-2c-paper': 'assets/logo/knoqra-wordmark-2c-paper.svg',
  'wordmark-black': 'assets/logo/knoqra-wordmark-black.svg',
  'wordmark-citron': 'assets/logo/knoqra-wordmark-citron.svg',
  'wordmark-ink': 'assets/logo/knoqra-wordmark-ink.svg',
  'wordmark-paper': 'assets/logo/knoqra-wordmark-paper.svg',
  'wordmark-white': 'assets/logo/knoqra-wordmark-white.svg',
  'icon-favicon': 'assets/icons/knoqra-favicon.svg',
  'icon-favicon-light': 'assets/icons/knoqra-favicon-light.svg',
  'icon-app-1024': 'assets/icons/knoqra-app-1024.svg',
  'icon-app-1024-light': 'assets/icons/knoqra-app-1024-light.svg',
  'icon-avatar': 'assets/icons/knoqra-avatar.svg',
  'icon-ext-48': 'assets/icons/knoqra-ext-48.svg',
  'icon-ext-128': 'assets/icons/knoqra-ext-128.svg',
} as const;

export type LogoAssetName = keyof typeof logoAssets;

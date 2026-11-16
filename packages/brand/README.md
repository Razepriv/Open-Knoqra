# @knoqra/brand

The official KNOQRA logo, icons and Otto mascot stills, as supplied in the brand package.
Private workspace package; the web app and docs import assets from it.

```ts
import markUrl from '@knoqra/brand/assets/logo/knoqra-mark-2c-night.svg';
import { BRAND_NAME, logoAssets } from '@knoqra/brand';
```

`logoAssets` maps a variant name to its path relative to this package. It exists for docs and
tests; apps import the files directly through the `./assets/*` export so the bundler hashes them.

## Which variant to use where

| Where | Variant |
| --- | --- |
| Dark tile (the Desk rail, app tiles) | `logo/knoqra-mark-2c-night.svg` (paper and citron strokes, no background) |
| Light UI, on paper or white | `logo/knoqra-mark-ink.svg` |
| Highlights on night backgrounds | `logo/knoqra-mark-citron.svg` |
| Single-colour print or watermarks | `mark-black`, `mark-white`, `mark-paper` |
| Wordmarks | `logo/knoqra-wordmark-*.svg`; `2c-night` is for dark backgrounds, `2c-paper` for light |
| Browser tab | `icons/knoqra-favicon.svg` (night tile) for light browser chrome, `icons/knoqra-favicon-light.svg` (citron tile) for dark chrome |
| App store, extension, avatar | `icons/knoqra-app-1024*.svg`, `icons/knoqra-ext-{48,128}.svg`, `icons/knoqra-avatar.svg` |

## Otto

`assets/mascot/otto-avatar.png` and `assets/mascot/otto-head-cut.png` are the still frames.

`reference/otto-head.js` is the source of the animated 3D head. It is reference for the M5 port
only. Nothing imports it and it must not be bundled. To port it:

1. Replace the CDN `import()` of three with the npm `three` dependency.
2. Wrap it as a React component with `mood` and `still` props.
3. Fall back to `otto-head-cut.png` when WebGL is unavailable or `prefers-reduced-motion` is set.

## SVG hygiene

The SVGs have their C2PA `<metadata>` block stripped; rendering is unchanged. `pnpm test` fails
if any SVG contains `<script`, an `on*=` handler, a `javascript:` URL, an external reference or
metadata, and if `reference/` becomes reachable from `src/index.ts`.

## Licence and trademarks

The KNOQRA name, the logo and the Otto character are trademarks and brand assets of the project
owner. They are not licensed under the repository's AGPL-3.0 code licence: the licence covers the
source code, not these assets. [TRADEMARKS.md](../../TRADEMARKS.md) says how they may be used. In
short, a self-hosted KNOQRA keeps them unchanged, and rebranding needs a commercial white-label
licence.

`POWERED_BY`, `BRAND_URL`, `COPYRIGHT_NOTICE`, `SOURCE_URL` and `legalLinks` feed the attribution
and legal notices that [ADDITIONAL-TERMS.md](../../ADDITIONAL-TERMS.md) requires every interface to
keep visible.

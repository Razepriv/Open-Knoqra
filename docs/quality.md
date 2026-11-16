# Quality checks

This page says what each completeness and quality check guards, how to run it, and how to keep it
true as branches land. The checks exist so that "the page renders" cannot hide a dead button, a
placeholder, an unreadable state or a layout that breaks at one width.

## Running the web checks

Every Playwright run starts its own API (`wrangler dev`) and web server, and needs a database. Set
these in the same shell command, pointing at your own database and free ports (see
[Running E2E in parallel worktrees](development.md#running-e2e-in-parallel-worktrees)):

```bash
export MIGRATION_DATABASE_URL=postgres://knoqra:knoqra@localhost:54329/<your_db>
export DATABASE_URL=postgres://knoqra_app:knoqra_app@localhost:54329/<your_db>
export KNOQRA_WEB_PORT=5282 KNOQRA_API_PORT=8882
```

Run Playwright from `apps/web`. Use `--workers=1` to `--workers=3` on a shared machine; the default
is 4. On a slow machine the 5 s expect timeout can trip sign-up; that is load, not a defect (CI
uses 10 s).

In CI, the per-push run leaves out the two slow suites, the crawler and the axe scan. The
`E2E (full)` workflow runs everything with `KNOQRA_FULL_E2E=1`, nightly on main and on demand
from the Actions tab. Run it before a release. Locally both suites always run.

| Check | What it guards | Command |
| --- | --- | --- |
| Placeholders | No "coming soon" or lorem text ships on a route that is not in the allowlist | `pnpm check:placeholders` |
| Script tests | The repo's Node scripts (placeholder check, imports guard) behave | `pnpm test:scripts` |
| Import guard | Apps never import `ascii-reveal`; loading states go through `Skeleton` and `Reveal` | `pnpm check:imports` |
| Secrets | No secret-looking value in the web bundle source | `pnpm --filter @knoqra/web check:secrets` |
| Crawler | Every visible, enabled control on every route, at 1440x900 and 390x844, does something; links point to known routes and new tabs use `rel=noopener`; focus returns after dialogs and menus; unexplained 4xx/5xx and console errors fail (see the limits below) | `pnpm exec playwright test crawl --workers=3`; narrow with `KNOQRA_CRAWL_ROUTES='/contacts,/contacts/$contactId (full)'` (pattern or label), add `KNOQRA_CRAWL_DEBUG=1` to log settle timeouts and noise |
| Accessibility | axe finds no serious or critical violation on any route or open state, at 1440 in both themes and at 390 in light; one main and one h1 per page; focus traps and focus return | `pnpm exec playwright test e2e/a11y.spec.ts --workers=3` (about 11 minutes) |
| States and feedback | Pending, success and failure feedback, toasts as live regions, offline saves, haptics, reduced motion | `pnpm exec playwright test e2e/states.spec.ts` |
| Skeletons | Each route draws its own layout-shaped outline, nothing shifts when content lands (CLS at most 0.01) | `pnpm exec playwright test e2e/skeletons.spec.ts` |
| Visual baselines | Screens and loading outlines at five widths in both themes | `pnpm --filter @knoqra/web e2e:visual` |
| Pixel pass | The app against the Desk v2 design, by eye and by measurement | see below |

### Pixel pass against the design

The design export lives outside the repository. Point `KNOQRA_DESIGN_DIR` at the folder that holds
`desk.html` (the Desk v2 export). Never commit that path.

```bash
cd apps/web
KNOQRA_DESIGN_DIR=<folder with desk.html> node scripts/capture-design.mjs
KNOQRA_PIXEL=1 pnpm exec playwright test --project=pixel --workers=1
```

`capture-design.mjs` renders the design at scale 1 (its canvas is a fixed 1440x900 div that scales
itself to fit the viewport, so a plain 1440x900 shot would shrink every measurement) and writes
`test-results/design/design-{today,contact}-{light,dark}.png`. It needs network for Google Fonts
and the lucide script. The pixel spec shoots the app's Today and Contact 360 (the seeded contact)
at 1440x900 into `test-results/pixel/app-*.png` and writes `app-*-surfaces.json` (every large
rounded surface: box, radius, shadow, fill, padding) and `app-contact-*-measure.json` (computed
type styles) for comparison with the design's inline styles. Playwright clears `test-results/` on
each run, so run the spec first and the capture script after, or copy the PNGs out.

### Dead-control crawler: known limits

- **Server-side write failures go unseen.** Outside throwaway contacts the crawler aborts every
  non-GET API request, so seed data, account settings and outward actions (send, call, buy,
  release, connect) never change anything, and an attempted write counts as the control doing
  something. A save that would fail on the server is therefore not caught here; the feature specs
  cover write failures. The crawler's own real writes are the destructive confirmations on
  throwaway contacts, a note on a throwaway, and sign-out.
- **Inside forms only the buttons are judged.** A blocked write or a validation message counts as
  alive, and multi-step flows are not followed past one level.
- **Noise masks are a heuristic.** A subtree that keeps changing on its own through two timed-out
  settle windows (a ticking clock) is left out of that page's effect checks. A mask never covers a
  control; masks are forgotten on every load and listed in the test annotations.
- **`e2e/completeness/known-defects.ts`** holds temporary exceptions, each naming its request. It
  must be empty before a milestone closes, and it is empty now.

## The pending-routes allowlist

`apps/web/completeness-allowlist.json` lists routes still owned by branches that have not merged.
It is one file read by the placeholder check, the crawler and the axe scan, so integration edits a
single place. **At the end of Phase 1 it is empty** (`"pending": []`): every route is real, and
`stub-page.tsx` is gone.

To add a stub route again (a page that ships as a placeholder before its stream lands):

1. Add the route file, with its placeholder content, in the owning stream's branch.
2. Add an entry to `completeness-allowlist.json` with `route`, `owner` and `files`, so the
   placeholder check, the crawler and the axe scan skip it.
3. When the stream merges, follow the lifecycle below.

When a branch merges:

1. Remove its entry from `completeness-allowlist.json`.
2. Delete the shared stub component with the last entry, if one was reintroduced. An empty list is
   the goal.
3. Re-run the crawler, the axe scan and the visual suite, and generate baselines for the new
   screens (see below).
4. De-duplicate `apps/web/e2e/visual/settle.ts` into the crawler's `waitForSettled` once the lanes
   have merged, so there is one settle helper.

## Visual baselines

Baselines live in `apps/web/e2e/visual/__baselines__/<platform>/` and are per platform, because
font rasterisation differs between operating systems (ruling R3). The `visual` Playwright project
runs only where a baseline folder exists for the current platform, or with `KNOQRA_VISUAL=1`; on
a platform without baselines it is left out and a note is printed, so CI on Linux skips it until
Linux baselines are added.

**Phase 1 ships no baselines.** By the owner's decision, no baseline set is committed from the
Windows development machine: those images would match neither the Mac nor CI's Linux runner.
Generate the first set on a Mac (below) or on CI's Linux image, after go-live setup, and commit
only that platform's folder. Until then the `visual` project is skipped everywhere.

What is shot, as `<screen>-<width>-<theme>.png` at widths 1440, 1280, 1024, 768 and 390 (height
900), light and dark, with the clock frozen at 2026-11-12T15:00:00Z, UTC and `en-US`, reduced
motion on, animations disabled and carets hidden:

- `sign-in`, `sign-up`, `forgot-password`, `reset-password-invalid`, `reset-password-form`,
  `two-factor`
- `contacts-empty`, `contacts-full`, `contact-360` (the seeded contact)
- `import-upload`, `import-map`, `import-review`, `import-results`
- `settings-profile`, `settings-preferences`, `settings-security`, `settings-sessions` (element
  shots of each section)
- `<route>-skeleton-<width>-<theme>.png` for the held-back loading outline of every route
  (`sign-in`, `sign-up`, `forgot-password`, `reset-password`, `two-factor`, `today`, `tasks`,
  `contacts`, `contact-360`, `contacts-import`, `settings`). The page script and the API are held
  until React has replaced the static outline from `index.html` with its own. `forgot-password`
  and `reset-password` never ask for a session, so they only have the static outline.

The loading-outline shots do not freeze the clock: the router's pending delay reads `Date`, and an
outline has no dates.

Volatile text is masked (`e2e/visual/masks.ts`): `time` elements, relative times, the "Created"
date and the random account email. Prefer stable data over a new mask.

Useful switches:

- `KNOQRA_VISUAL_FRAMES=1440:light,390:dark` restricts a run to those frames (prove one screen
  without shooting all ten).
- Add `-g "<screen>"` to restrict to one test.

### Generating baselines on a Mac (or on CI's Linux image)

On Linux the steps are the same and the folder is `__baselines__/linux/`.

Font rendering differs per platform, which is why each platform has its own folder.

1. `pnpm install`
2. `pnpm --filter @knoqra/web exec playwright install chromium`
3. Set the database, port and `KNOQRA_VISUAL=1` environment as above.
4. `pnpm --filter @knoqra/web e2e:visual:update`
5. Review the new files under `apps/web/e2e/visual/__baselines__/darwin/`. Open a sample of each
   screen at 390 and 1440, light and dark, and look for overflow, clipped text or sideways scroll.
6. Run `pnpm --filter @knoqra/web e2e:visual` twice: both runs must show zero diffs.
7. Commit the `darwin` folder.

A change that moves pixels on purpose is regenerated the same way, after you have looked at the
diff and agreed with it.

## Checklists

### State coverage

Each view needs proof in a spec for every cell. Use `page.route` to answer 500 or 403,
`context.setOffline(true)` for offline, and a held route to see the skeleton.

| View | empty | loading | error | offline | denied |
| --- | --- | --- | --- | --- | --- |
| Contacts list | yes | yes | yes | yes | yes |
| Contact 360, and not found | yes (empty timeline) | yes | yes | yes | yes |
| Import, per step | yes (no file) | yes (run) | yes (batch 500) | yes (mid-run) | yes |
| Settings sections | n/a (a section always has content) | yes | yes | yes | yes |
| Auth pages | n/a | yes (submit pending) | yes | yes | n/a |

The shared pieces are `StatePanel` and `QueryStatePanel` (`apps/web/src/components/states/`), the
`queryStateKind` mapping (403 or `forbidden` means denied, 404 means not found, a network failure
or an offline browser means offline, everything else an error) and `OfflineBanner`. Copy is one
plain sentence naming the subject, and never claims queuing that does not happen: offline says
changes "will not save until you reconnect".

Saves must fail fast while offline. TanStack Query pauses a mutation when the browser reports
offline, which leaves a form stuck behind a disabled button; saves therefore use
`networkMode: 'always'` (`OFFLINE_FAILS_FAST` in `apps/web/src/lib/query-state.ts`).

### Action feedback

Every action shows pending, success and failure:

- Pending: `aria-busy`, the control disabled or guarded against a second press, and label text such
  as "Saving...".
- Success: a toast through `useToast()` (an always-mounted `role="status"` region, so screen readers
  announce it) or an inline confirmation. A toast that must survive a dialog or card unmounting
  belongs in a parent that stays mounted, and mutate-level callbacks are not used where the hook's
  own `onSuccess` can unmount the caller (use `mutateAsync`).
- Failure: a `FormAlert` or a toast, and the control is enabled again.
- Haptics (`apps/web/src/lib/haptics.ts`, silent when unsupported or under reduced motion):
  `success` on a successful save, merge and a completed import; `warning` when the person confirms
  a destructive dialog (archive, merge, do not contact, two-factor off, revoke a session, sign
  out); `error` on a failed save. A cancelled import gives none.
- Toasts clear the phone bottom navigation (`bottom-24`, `lg:bottom-6`).
- Motion uses the `--dur-*` and `--ease-standard` tokens; with reduced motion every transition and
  animation computes to at most 1 ms.

Audited actions and where they stand:

| Action | Feedback | Haptic |
| --- | --- | --- |
| Create contact | disabled and busy, "Adding...", toast, `FormAlert` on failure | success, error |
| Edit contact | disabled and busy, "Saving...", toast, `FormAlert` | success, error |
| Archive, restore | menu item busy, toast on both outcomes | warning on confirm, success, error |
| Add note | busy, "Adding...", toast, inline alert keeps the text | success, error |
| Merge | busy, "Merging...", toast, inline alert in the dialog | warning, success, error |
| Dismiss duplicate | busy, "Saving...", toast, inline alert | success, error |
| Import run | run step, results step | success when completed, error when failed |
| Theme cycle | immediate apply, rollback and toast on failure | error |
| Sign out | busy, "Signing out...", toast on failure | warning, error |
| Consent, do not contact, profile save, two-factor, revoke session, preferences | per-section feedback, covered with the per-view states pass | as above |

## Design rulings

Desk v2 is the visual source of truth. Each deviation found in the pixel pass is fixed or recorded
here as a ruling. Sizes were measured at the design's real scale (see the pixel pass above).

### Plan rulings

| Ruling | Decision |
| --- | --- |
| R1 | Desk v2 is a fixed 1440x900 canvas that scales, not a responsive layout. Pixel comparison happens at 1440 only. The other widths follow the spec breakpoints (three panes at 1280 and up, a drawer at 1024 to 1279, one column below 1024) and are guarded by visual baselines. |
| R2 | The pending-routes allowlist is the single file `apps/web/completeness-allowlist.json`. |
| R3 | Visual baselines are per platform; the `visual` project runs only where a baseline set exists or with `KNOQRA_VISUAL=1`. |
| R4 | The pre-JS first paint is a static CSS outline inline in `index.html`, because ascii-reveal needs JS. It hands over to the ascii-reveal skeletons on the first render. |
| R5 | Layout-shaped skeletons were added as Task 11, so the crawler, axe scan and visual baselines cover them. Today is not redesigned by the pixel pass. |

#### CSP and the first paint (R4)

`apps/web/index.html` has two inline scripts: the saved-theme script in `<head>` and the outline
picker after `#root`. The picker adds `kq-is-auth kq-r-<page>` and `data-skeleton` on auth pages.
A Content-Security-Policy without `'unsafe-inline'` (M6d) must list each script's `sha256-...` hash
in `script-src`. The hash covers the exact bytes between `<script>` and `</script>`, which start
with the newline after `<script>`, use LF line endings, and end with the four spaces before
`</script>`. **Any edit, including a Biome reformat, changes the hash**, so recompute it and update
the policy in the same commit. From the repo root:

```sh
node -e "const h=require('fs').readFileSync('apps/web/index.html','utf8');for(const m of h.matchAll(/<script>([\s\S]*?)<\/script>/g))console.log('sha256-'+require('crypto').createHash('sha256').update(m[1]).digest('base64'))"
```

Current values, recomputed from `apps/web/index.html` at commit `9ad8939` (the file last changed in
`0836424`):

- Saved-theme script, in `<head>`: `sha256-qz4HycC8Jd6Up9VIe5zBIcfvenBSSRI5iTMeZTpgtsY=`
- Outline picker, after `#root`: `sha256-LV5YzVGydicSrkUKtq3VzPww9xAwLm46BhXIpE3siJ8=`

The saved-theme script, byte for byte:

```html
    <script>
      // Apply a saved theme before first paint. With nothing saved, data-theme stays unset and
      // the prefers-color-scheme block in tokens.css follows the system. See src/lib/theme.ts.
      try {
        const saved = localStorage.getItem('knoqra.theme');
        if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
      } catch {}
    </script>
```

The outline picker, byte for byte:

```html
    <script>
      (() => {
        var page = location.pathname.replace(/\/+$/, '').slice(1);
        if (['sign-in', 'sign-up', 'forgot-password', 'reset-password', 'two-factor'].indexOf(page) < 0) return;
        var outline = document.getElementById('kq-outline');
        outline.className += ` kq-is-auth kq-r-${page}`;
        outline.setAttribute('data-skeleton', page);
      })();
    </script>
```

The inline `<style>` in the same file is also inline, so a CSP needs `style-src` to allow it (a hash or a
nonce). `apps/web/src/index-html.test.ts` keeps the outline's `--o-*` colour fallbacks equal to
`tokens.css`, so a token change that is not mirrored there fails a unit test.

### Deviations from the design

Status: fixed means changed in the app; ruling means the app keeps its value on purpose; artifact
means a measurement difference only (the design scales its canvas).

| Screen | Element | Design | Desk | Status |
| --- | --- | --- | --- | --- |
| Both | Page margin around the shell | canvas fills 1440 | 24px margin | ruling (R1) |
| Both | Rail width, top bar height, pill height, avatar size | 68 / 62 / 42 / 42 | same | artifact |
| Both | Top-bar tabs, search, presence avatars, channel chip, Call back, Customize | present | not built | ruling: owned by M2, M3, M4 and the palette stream |
| Both | Theme control icon | sun and moon | monitor, sun, moon (system option) | ruling |
| Both | Rail items and inbox badge | grid item, badge | phone item, no badge | ruling: M2 and M3 |
| Both | Account avatar | solid dark disc, light text | was a lime gradient | fixed (`Avatar tone="ink"`) |
| Contact | Header actions | right column, Call 40, WhatsApp 38, SMS 38 dashed when paused | row below the chips | fixed |
| Contact | Call button emphasis | lime primary | white until calling exists | ruling: M2 |
| Contact | Subtitle line height | 1.3 | 1.5 | fixed |
| Contact | Note composer in the timeline | absent | present | ruling: required behaviour |
| Contact | Permission status wording | channel states | server states | ruling: M2, M3 |
| Contact | Next action card | present | absent | ruling: M5 |
| Contact | Contacts column, row height and widths | 272 / 56 | same | artifact |
| Contact | Contacts search field | 40 high, radius 20, flat | 44 high, pill, inset | to fix |
| Contact | Timeline rows, filter pills, panel padding | filled cells with eyebrow and meta line, 32 pills radius 16, padding 18/20 | outline rows, 34 pills, padding 20 | to fix |
| Contact | Permission rows | compact 56 | 92 to 112 | to fix |
| Contact | Provenance | single mono caption | labelled block | to fix |
| Today | Composition, week controls, card content | full-width week panel, four cards in a row | greeting, Workspace column, 2x2 cards | ruling: M5 |

"To fix" rows are the second part of the pixel pass and move to "fixed" as they land.

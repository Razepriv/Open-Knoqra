# Skeleton kit

A loading state in KNOQRA shows the outline of the page that is coming: the same grid, panels,
paddings and fixed heights, filled with the ascii-reveal glyph pattern. When the data lands,
nothing moves. The kit lives in [`src/skeleton-kit.tsx`](src/skeleton-kit.tsx) and every part is
built from [`Skeleton`](src/skeleton.tsx).

## Rules

- Mirror the real component: its padding, gap, radius and fixed heights. A line of text is a line
  box as tall as the text's `font-size × line-height` (use `lineHeight`).
- Share layout classes rather than copy them. When an outline needs a real component's grid or
  frame, move those classes into one constant both use: [`shellLayout`](src/shell-layout.ts) (the
  Desk frame), [`authLayout` and `listRow`](src/layouts.ts) (the auth page, a contact row), or a web
  module such as `apps/web/src/lib/contacts-layout.ts` (Contact 360's columns, the contact list).
  Where a page belongs to another stream and cannot be restructured (Today, owned by M5), copy the
  classes and leave a comment naming the source file and line.
- A page-level outline announces itself once: one `role="status"` with a human label ("Loading
  your contacts"). Every part is `aria-hidden`. Never put the status inside a widget whose role
  limits its children (a `listbox`, a `list`, a `table`): announce beside it instead.
- An outline that renders inside the shell's `<main>` adds no `main` and no `h1`. `SkeletonShell`
  and `SkeletonAuth` are the only parts that render a `<main>`, because they stand in for the whole
  page.
- Put `data-skeleton="<route-id>"` on a page outline's root; the E2E and visual baselines key on it.
- Reduced motion stops the shimmer (ascii-reveal checks `prefers-reduced-motion` itself).
- Apps import the kit from `@knoqra/ui`, never `ascii-reveal` (`pnpm check:imports`).

## Proving it: CLS and anchors

`apps/web/e2e/skeletons.spec.ts` holds each page's requests back, then releases them.

- **CLS** (≤ 0.01) catches movement of nodes that stay on screen: in-page outlines that the real
  content replaces inside a component that persists.
- **The limit:** when a route-level outline (a router `pendingComponent`) gives way to the page,
  every node is new, and the Layout Instability API reports nothing, however far things jump.
- **Anchors** cover that swap. Mark the outline's first panel and header blocks with
  `data-skeleton-part="<name>"`; give the matching real block a stable selector (a role and name),
  or `data-anchor="<name>"` when it has none. The spec records each outline block's box while the
  outline is held and asserts that the loaded page's block lands within 4px. Pick blocks at the top
  of the page: lower blocks follow content whose length the outline cannot know (how many rows,
  how a headline wraps). The static outline in `index.html` carries the same hooks.

## Parts

Every part takes `className`. Lengths are a number (px) or any CSS length; a bare number in
`widths` is a percentage.

### `SkeletonStatus`

The one announcement, visually hidden. `label` is what assistive tech reads.

```tsx
<SkeletonStatus label="Loading your contacts" />
```

### `SkeletonPanel`

A Panel surface; other HTML attributes pass through (`data-skeleton`, `data-skeleton-part`).
`label` makes it the outline's status; without one the panel is `aria-hidden`.

```tsx
<SkeletonPanel label="Loading your tasks" className="flex flex-col gap-5 p-6 sm:p-8">
  …
</SkeletonPanel>
```

### `SkeletonText`

Lines whose boxes follow the type scale.

- `lines` (1): how many lines.
- `widths`: a width per line, cycled.
- `size`: `display`, `title`, `body` or `mono`.
- `lineHeight`: an exact box height (a number or a `clamp()`), for type set off the scale.
- `align`: `start`, `center` or `end`, for centred or right-aligned text.
- `seed`: varies the glyph pattern.

Prefer `rem` widths inside flex rows: a percentage needs a parent of definite width.

```tsx
<SkeletonText lines={2} widths={[90, 60]} lineHeight={22.75} />
<SkeletonText widths={['9rem']} lineHeight={24} align="center" className="w-full" />
```

### `SkeletonAvatar`

A circle. `size` defaults to 36; `seed` varies the glyph pattern.

```tsx
<SkeletonAvatar size={84} />
```

### `SkeletonButton`

A pill.

- `size`: `md` (40px), `sm` (32px), `lg` (48px), or `icon` (a 42px round pill with an icon glyph).
- `width`: defaults to 120, 96, 160 and 42 for those sizes.
- `height`: covers controls off those sizes (a 34px text pill, a 40px icon pill).

```tsx
<SkeletonButton width={137} />
<SkeletonButton size="icon" height={40} />
```

### `SkeletonField`

The label line and the 48px sunken field, as `Field` draws them.

- `label` (true): draws the label line.
- `hint`: adds the mono hint line under the field.
- `width`: the field's width.

```tsx
<SkeletonField hint />
```

### `SkeletonRow`

A list row: circle, one or two text lines, an optional trailing pill or dot.

- `avatar` (true) and `avatarSize` (36).
- `lines`: 1 or 2.
- `trailing`: `pill`, `dot` or `none`.
- `surface`: `card` is the 56px bordered row (`listRow`, as ContactRow); `plain` has no surface,
  so the caller sets padding.
- `seed`: picks one of four name-length line pairs and varies the glyphs.

```tsx
<SkeletonRow trailing="pill" seed={2} />
<SkeletonRow surface="plain" lines={1} className="px-3 py-2.5" />
```

### `SkeletonShell`

The Desk frame. It draws:

- the rail and the top bar: title, workspace chip, icon pills, and a context pill below 1280px
  when there is a ribbon;
- the page slot in the one `<main>`;
- the ribbon column from 1280px.

It shares `shellLayout` with the web app's `AppShell`. Its props:

- `ribbon`: `true` draws a plain ribbon panel; a node is the ribbon's own outline.
- `railItems` (7): circles on the rail, the pages plus Settings (pass `NAV_ITEMS.length + 1`).
- `titleWidth` (120): width of the top-bar title, close to the real page title.
- `label`: makes the frame the status, when the page slot has none of its own.

Other attributes pass through to the root.

```tsx
<SkeletonShell data-skeleton="shell" railItems={7} titleWidth={112} ribbon={<RibbonOutline />}>
  <ContactsSkeleton />
</SkeletonShell>
```

### `SkeletonAuth`

The two-panel auth outline (`authLayout`, as AuthLayout): brand side and the form card.

- `fields`: a count, or a `SkeletonFieldProps` per field (for hints).
- `afterFields`: anything between the fields and the button (a checkbox, a "Forgot password?" link).
- `afterButton`: anything under the button (a "Use a backup code instead" link).
- `titleWraps`: the form title takes a second line below 640px, for a long title in the narrow
  card ("Forgot your password?").
- `label`: makes it the status.

Other attributes pass through to the `<main>`. Its panels carry the anchors `auth-hero`,
`auth-form` and `auth-form-column`, and each field `field`.

```tsx
<SkeletonAuth data-skeleton="sign-up" label="Loading sign up" fields={[{}, {}, { hint: true }]} />
```

### `Skeleton`

The single glyph primitive the parts are built from. On top of the ascii-reveal props (`variant`,
`lines`, `widths`, `rows`, `width`, `height`, `circle`, `animate`), it takes:

- `seed`: varies the glyph pattern.
- `label` ("Loading"): its own status.
- `decorative`: drops the status and hides it, for use inside a larger outline.

With only a `width` and `height` it draws one block of that size. It clips its own shimmer canvas.

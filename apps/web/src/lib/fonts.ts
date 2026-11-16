/**
 * Every webfont face the Desk draws with (see styles.css). A face downloads only when text first
 * uses it, so one first used by late content (the mono chips of a contact header) arrived after
 * that content and reflowed the page. Loading them all at startup removes that shift.
 */
export const FONT_FACES: readonly string[] = [
  '400 1em "Inter Variable"',
  '400 1em "Space Grotesk"',
  '500 1em "Space Grotesk"',
  '400 1em "IBM Plex Mono"',
  '500 1em "IBM Plex Mono"',
];

/** Starts loading every face now. Fire and forget: a face that fails keeps its fallback. */
export function preloadFonts(fonts: Pick<FontFaceSet, 'load'> | undefined): void {
  if (!fonts) return;
  for (const face of FONT_FACES) {
    fonts.load(face).catch(() => {
      // The fallback stack renders instead; nothing to tell the user.
    });
  }
}

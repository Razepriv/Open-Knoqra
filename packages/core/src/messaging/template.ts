import { err, ok, type Result } from '../result';

export const TEMPLATE_PLACEHOLDERS = ['first_name', 'name', 'company'] as const;
type Placeholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/**
 * Any `{{...}}` span, so malformed placeholders such as `{{First_Name}}`, `{{firstName}}`,
 * `{{first-name}}` or `{{}}` are caught as unknown instead of being sent with their braces. The
 * trimmed inner text must be exactly a known name; `{{ first_name }}` is valid. The web template
 * picker keeps an identical copy of this pattern (apps/web/src/components/inbox/template-picker.tsx).
 */
const PATTERN = /\{\{([^{}]*)\}\}/g;

function placeholderName(inner: string): string {
  return inner.trim();
}

function isKnown(name: string): name is Placeholder {
  return (TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name);
}

function distinctNames(body: string): string[] {
  return [...new Set([...body.matchAll(PATTERN)].map((m) => placeholderName(m[1] ?? '')))];
}

/** The distinct `{{name}}` placeholders in a body, or the unknown ones. */
export function templatePlaceholders(body: string): Result<string[], { unknown: string[] }> {
  const names = distinctNames(body);
  const unknown = names.filter((n) => !isKnown(n));
  return unknown.length > 0 ? err({ unknown }) : ok(names);
}

/** Fills placeholders from a contact. Unknown or empty values are reported as `missing`. */
export function renderTemplate(
  body: string,
  contact: { displayName: string; company: string | null },
): Result<string, { missing: string[] }> {
  const values: Record<Placeholder, string> = {
    first_name: contact.displayName.trim().split(/\s+/)[0] ?? '',
    name: contact.displayName.trim(),
    company: contact.company?.trim() ?? '',
  };
  const missing = distinctNames(body).filter((n) => !isKnown(n) || values[n] === '');
  if (missing.length > 0) return err({ missing });
  return ok(
    body.replace(PATTERN, (_m, inner: string) => values[placeholderName(inner) as Placeholder]),
  );
}

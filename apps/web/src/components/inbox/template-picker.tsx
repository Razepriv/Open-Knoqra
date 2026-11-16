import { useId } from 'react';
import type { MessageTemplate } from '../../lib/inbox';
import { focusRing } from '../../lib/ui-classes';

export interface PreviewContact {
  displayName: string;
  company: string | null;
}

export interface PreviewPart {
  text: string;
  /** True for a filled-in placeholder (or one with no value, left as `{{name}}`). */
  placeholder: boolean;
  missing: boolean;
  /** Where the part starts in the body, which makes a stable key. */
  offset: number;
}

// Identical to PATTERN in packages/core/src/messaging/template.ts (the web app does not depend on
// @knoqra/core): any `{{...}}` span, whose trimmed inner text must be exactly a known name, so
// `{{First_Name}}` or `{{}}` shows as missing rather than as plain text.
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

function valueFor(name: string, contact: PreviewContact): string {
  const displayName = contact.displayName.trim();
  if (name === 'first_name') return displayName.split(/\s+/)[0] ?? '';
  if (name === 'name') return displayName;
  if (name === 'company') return contact.company?.trim() ?? '';
  return '';
}

/**
 * The template body as this contact would get it, split so placeholders can be highlighted. It
 * mirrors the server's fill rules; the server renders the message that is actually sent.
 */
export function previewParts(body: string, contact: PreviewContact): PreviewPart[] {
  const parts: PreviewPart[] = [];
  let last = 0;
  for (const match of body.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({
        text: body.slice(last, index),
        placeholder: false,
        missing: false,
        offset: last,
      });
    }
    const value = valueFor((match[1] ?? '').trim(), contact);
    parts.push({
      text: value || match[0],
      placeholder: true,
      missing: value === '',
      offset: index,
    });
    last = index + match[0].length;
  }
  if (last < body.length) {
    parts.push({ text: body.slice(last), placeholder: false, missing: false, offset: last });
  }
  return parts;
}

export function TemplatePreview({ body, contact }: { body: string; contact: PreviewContact }) {
  return (
    <span className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]">
      {previewParts(body, contact).map((part) =>
        part.placeholder ? (
          <mark
            key={part.offset}
            className="rounded-[6px] px-[3px] font-medium text-[color:var(--on-accent)]"
            style={{ background: part.missing ? 'var(--grad-amber)' : 'var(--grad-hl)' }}
          >
            {part.text}
          </mark>
        ) : (
          <span key={part.offset}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export interface TemplatePickerProps {
  templates: readonly MessageTemplate[];
  contact: PreviewContact;
  value: string | null;
  onChange: (templateId: string) => void;
}

/** A radio list of approved templates, each with the message this contact would receive. */
export function TemplatePicker({ templates, contact, value, onChange }: TemplatePickerProps) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 font-semibold text-[14px] leading-[1.3]">
        {`Use an approved template to message ${contact.displayName}.`}
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((template) => {
          const checked = template.id === value;
          return (
            <label
              key={template.id}
              className={`flex cursor-pointer flex-col gap-[6px] rounded-[16px] border px-3 py-[10px] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2 ${
                checked
                  ? 'border-transparent text-[color:var(--on-accent)]'
                  : 'border-[color:var(--pillBorder)] bg-[color:var(--cell)]'
              }`}
              style={checked ? { background: 'var(--grad-cit)' } : undefined}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name={name}
                  value={template.id}
                  checked={checked}
                  onChange={() => onChange(template.id)}
                  className={`size-4 accent-[color:var(--line)] ${focusRing}`}
                />
                <span className="font-[family-name:var(--font-mono)] font-medium text-[11px] uppercase leading-none">
                  {template.name}
                </span>
              </span>
              <TemplatePreview body={template.body} contact={contact} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

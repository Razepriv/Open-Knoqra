import { describe, expect, it } from 'vitest';
import { renderTemplate, templatePlaceholders } from './template';

const maya = { displayName: 'Maya Okafor', company: 'Acme' };

describe('renderTemplate', () => {
  it('renders known placeholders', () => {
    expect(renderTemplate('Hi {{first_name}} at {{company}}', maya)).toEqual({
      ok: true,
      value: 'Hi Maya at Acme',
    });
  });
  it('renders name and repeated placeholders', () => {
    expect(renderTemplate('{{name}}/{{name}}', maya)).toEqual({
      ok: true,
      value: 'Maya Okafor/Maya Okafor',
    });
  });
  it('reports a null company as missing', () => {
    expect(renderTemplate('Hi {{company}}', { ...maya, company: null })).toEqual({
      ok: false,
      error: { missing: ['company'] },
    });
  });
  it('treats an empty company as missing', () => {
    expect(renderTemplate('{{company}}', { ...maya, company: '' })).toEqual({
      ok: false,
      error: { missing: ['company'] },
    });
  });
  it('reports an empty first name as missing', () => {
    expect(renderTemplate('{{first_name}}', { displayName: '  ', company: null })).toEqual({
      ok: false,
      error: { missing: ['first_name'] },
    });
  });
  it('leaves a body with no placeholders unchanged', () => {
    expect(renderTemplate('Hello there', maya)).toEqual({ ok: true, value: 'Hello there' });
  });
  it('treats unknown placeholders as missing', () => {
    expect(renderTemplate('{{phone}}', maya)).toEqual({
      ok: false,
      error: { missing: ['phone'] },
    });
  });
});

describe('templatePlaceholders', () => {
  it('returns distinct known names', () => {
    expect(templatePlaceholders('{{name}} {{ company }} {{name}}')).toEqual({
      ok: true,
      value: ['name', 'company'],
    });
  });
  it('returns no names for a plain body', () => {
    expect(templatePlaceholders('plain')).toEqual({ ok: true, value: [] });
  });
  it('rejects unknown names', () => {
    expect(templatePlaceholders('{{phone}} {{name}} {{phone}}')).toEqual({
      ok: false,
      error: { unknown: ['phone'] },
    });
  });
  it.each(['{{First_Name}}', '{{firstName}}', '{{first-name}}', '{{}}'])(
    'rejects the malformed placeholder %s as unknown',
    (body) => {
      const result = templatePlaceholders(`Hi ${body}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.unknown).toHaveLength(1);
    },
  );
  it('reports the trimmed inner text of a malformed placeholder', () => {
    expect(templatePlaceholders('{{ First_Name }} {{}}')).toEqual({
      ok: false,
      error: { unknown: ['First_Name', ''] },
    });
  });
  it('accepts a known name with inner spaces', () => {
    expect(templatePlaceholders('Hi {{ first_name }}')).toEqual({
      ok: true,
      value: ['first_name'],
    });
  });
});

describe('renderTemplate with malformed placeholders', () => {
  it('renders a known name with inner spaces', () => {
    expect(renderTemplate('Hi {{ first_name }}!', maya)).toEqual({ ok: true, value: 'Hi Maya!' });
  });
  it.each(['{{First_Name}}', '{{firstName}}', '{{first-name}}', '{{}}'])(
    'never sends %s with its braces',
    (body) => {
      expect(renderTemplate(`Hi ${body}`, maya).ok).toBe(false);
    },
  );
});

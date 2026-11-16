import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field } from './field';

const render = (props: { error?: string | null; hint?: string }) =>
  renderToStaticMarkup(createElement(Field, { id: 'email', label: 'Email', ...props }));

describe('Field errors', () => {
  it('keeps a polite live region in the DOM even with no error, so changes are announced', () => {
    const html = render({});
    expect(html).toMatch(/<div[^>]*aria-live="polite"[^>]*><\/div>/);
  });

  it('puts the error text inside the polite live region and links it to the input', () => {
    const html = render({ error: 'Enter an email address.' });
    expect(html).toMatch(/aria-live="polite"[^>]*>.*id="email-error".*Enter an email address\./);
    expect(html).toContain('aria-describedby="email-error"');
    expect(html).toContain('aria-invalid="true"');
  });
});

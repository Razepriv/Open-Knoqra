import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { copy } from '../lib/auth-errors';
import { FormAlert } from './form-alert';

const render = (props: { message: string | null; tone?: 'error' | 'notice' }) =>
  renderToStaticMarkup(createElement(FormAlert, props));

describe('FormAlert', () => {
  it('renders nothing without a message', () => {
    expect(render({ message: null })).toBe('');
  });

  it('announces errors assertively', () => {
    expect(render({ message: 'Nope.' })).toMatch(/role="alert"[^>]*>Nope\./);
  });

  it('announces a notice politely, as a status, not an alert', () => {
    const html = render({ message: copy.sessionExpired, tone: 'notice' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('Your session ended. Sign in again to continue.');
  });
});

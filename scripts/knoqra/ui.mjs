// Output helpers. Every line goes through `redact`, so a secret value cannot reach the terminal
// even inside an error message from Cloudflare, Postgres or a child process wrapper.
import { redact } from './settings.mjs';

const STYLES = { bold: [1, 22], dim: [2, 22], green: [32, 39], red: [31, 39], yellow: [33, 39] };

/**
 * @param {object} options
 * @param {(text: string) => void} options.write  where output goes (process.stdout.write in the CLI)
 * @param {boolean} [options.color]               ANSI colors on or off
 * @param {() => string[]} [options.secrets]      the current secret values to hide
 */
export function createUi({ write, color = false, secrets = () => [] }) {
  const paint = (style, text) => {
    if (!color) return text;
    const [open, close] = STYLES[style];
    return `\u001b[${open}m${text}\u001b[${close}m`;
  };
  const line = (text = '') => write(`${redact(text, secrets())}\n`);
  return {
    paint,
    line,
    step: (title) => {
      line();
      line(paint('bold', title));
    },
    info: (text) => line(`  ${paint('dim', text)}`),
    text: (text) => line(`  ${text}`),
    ok: (text) => line(`  ${paint('green', '✓')} ${text}`),
    warn: (text) => line(`  ${paint('yellow', '!')} ${text}`),
    bad: (text) => line(`  ${paint('red', '✗')} ${text}`),
    raw: (text) => write(redact(text, secrets())),
  };
}

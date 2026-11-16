// Reads and writes the self-host settings file (`.env.selfhost`): one KEY=value per line, `#`
// comments. Updates keep every other line as it was. The file holds secrets, so it is written
// with mode 600 and its values are never printed.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const ENV_HEADER = [
  '# KNOQRA self-host settings, written by `pnpm knoqra setup` and read by `pnpm knoqra deploy`.',
  '# It holds secrets: keep it private, never commit it, and back it up somewhere safe (a password',
  '# manager). Without CREDENTIALS_MASTER_KEY the provider keys stored in the database are unreadable.',
  '',
].join('\n');

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function decode(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function encode(value) {
  const text = String(value);
  return /[\r\n]|^\s|\s$|^["']/.test(text) ? JSON.stringify(text) : text;
}

/** Parses env text into a plain object. A later line for the same key wins. */
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (match) values[match[1]] = decode(match[2]);
  }
  return values;
}

/**
 * Applies `updates` to env text. A key with a value is replaced in place (or appended); a key whose
 * value is '', null or undefined is removed. Every other line, comments included, is kept.
 */
export function updateEnvText(text, updates) {
  const pending = new Map(Object.entries(updates));
  const seen = new Set();
  const lines = [];
  for (const line of text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/)) {
    const match = LINE.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = pending.get(key);
    if (value !== '' && value !== null && value !== undefined)
      lines.push(`${key}=${encode(value)}`);
  }
  for (const [key, value] of pending) {
    if (seen.has(key) || value === '' || value === null || value === undefined) continue;
    lines.push(`${key}=${encode(value)}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** The keys whose value differs between two settings objects, with the new value ('' if gone). */
export function changedValues(before, after) {
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[key] ?? '';
    const now = after[key] ?? '';
    if (old !== now) changes[key] = now;
  }
  return changes;
}

/** Reads the settings file. A missing file reads as empty. */
export function readEnvFile(path) {
  if (!existsSync(path)) return { exists: false, text: '', values: {} };
  const text = readFileSync(path, 'utf8');
  return { exists: true, text, values: parseEnv(text) };
}

/** Writes the settings file atomically, readable and writable by its owner only (mode 600). */
export function writeEnvFile(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

/** Saves `values` over the file's current content: only changed keys are touched. */
export function saveEnvValues(path, values) {
  const current = readEnvFile(path);
  const changes = changedValues(current.values, values);
  const base = current.exists ? current.text : ENV_HEADER;
  if (current.exists && Object.keys(changes).length === 0) return false;
  writeEnvFile(path, updateEnvText(base, changes));
  return true;
}

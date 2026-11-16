// Repository docs check: relative Markdown links resolve, and the tracker YAML files are valid and
// consistent (every issue names a real milestone and only labels defined in .github/labels.yml).
// Cross-platform: plain Node, no shell. Run with `pnpm docs:check`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', '.wrangler', 'dist', '.superpowers']);
const errors = [];

const out = (line) => process.stdout.write(`${line}\n`);
const rel = (p) => relative(root, p).split(sep).join('/');

function walk(dir, accept, found = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, found);
    else if (accept(name)) found.push(full);
  }
  return found;
}

/** Markdown with fenced code blocks and inline code removed, so examples are not scanned. */
function stripCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

function checkLinks(file) {
  const text = stripCode(readFileSync(file, 'utf8'));
  let count = 0;
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
    if (path === '') continue;
    count += 1;
    const resolved = path.startsWith('/') ? join(root, path) : resolve(dirname(file), path);
    if (!existsSync(resolved)) errors.push(`${rel(file)}: broken link (${target})`);
  }
  return count;
}

function readYaml(path) {
  try {
    return parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    errors.push(`${path}: cannot parse YAML (${error.message})`);
    return null;
  }
}

function checkTracker() {
  const labels = readYaml('.github/labels.yml');
  const tracker = readYaml('docs/roadmap/issues.yml');
  if (!Array.isArray(labels) || !tracker) return { labels: 0, milestones: 0, issues: 0 };

  const labelNames = new Set();
  for (const label of labels) {
    const where = `.github/labels.yml: ${label?.name ?? '(unnamed)'}`;
    if (typeof label?.name !== 'string' || label.name === '') errors.push(`${where}: missing name`);
    else if (labelNames.has(label.name)) errors.push(`${where}: duplicate label`);
    else labelNames.add(label.name);
    if (!/^[0-9A-Fa-f]{6}$/.test(String(label?.color ?? ''))) {
      errors.push(`${where}: color must be 6 hex digits without #`);
    }
    if (typeof label?.description !== 'string' || label.description === '') {
      errors.push(`${where}: missing description`);
    } else if (label.description.length > 100) {
      errors.push(`${where}: description is over GitHub's 100 character limit`);
    }
  }

  const milestones = tracker.milestones ?? [];
  const issues = tracker.issues ?? [];
  const milestoneTitles = new Set();
  for (const m of milestones) {
    if (typeof m?.title !== 'string' || m.title === '')
      errors.push('issues.yml: milestone without title');
    else if (milestoneTitles.has(m.title))
      errors.push(`issues.yml: duplicate milestone ${m.title}`);
    else milestoneTitles.add(m.title);
    if (typeof m?.description !== 'string')
      errors.push(`issues.yml: milestone ${m?.title} needs a description`);
  }
  const titles = new Set();
  for (const issue of issues) {
    const where = `issues.yml: "${issue?.title}"`;
    if (typeof issue?.title !== 'string' || issue.title === '')
      errors.push('issues.yml: issue without title');
    else if (titles.has(issue.title)) errors.push(`${where}: duplicate title`);
    else titles.add(issue.title);
    if (!milestoneTitles.has(issue?.milestone))
      errors.push(`${where}: unknown milestone ${issue?.milestone}`);
    if (!Array.isArray(issue?.labels) || issue.labels.length === 0)
      errors.push(`${where}: needs labels`);
    for (const l of issue?.labels ?? []) {
      if (!labelNames.has(l)) errors.push(`${where}: unknown label ${l}`);
    }
    const body = String(issue?.body ?? '');
    for (const heading of ['## Context', '## Scope', '## Acceptance criteria']) {
      if (!body.includes(heading)) errors.push(`${where}: body lacks "${heading}"`);
    }
  }
  return { labels: labelNames.size, milestones: milestoneTitles.size, issues: issues.length };
}

function checkYamlFiles() {
  const files = walk(root, (n) => /\.ya?ml$/.test(n)).filter(
    (f) => !rel(f).startsWith('pnpm-lock'),
  );
  for (const file of files) readYaml(rel(file));
  return files.length;
}

// A website's content collections (`src/content/` under an app) link to the site's own routes, such as
// `/pricing/`, not to repository files, so their links are the site build's to check.
const markdown = walk(root, (n) => n.endsWith('.md')).filter(
  (file) => !rel(file).includes('/src/content/'),
);
let links = 0;
for (const file of markdown) links += checkLinks(file);
const tracker = checkTracker();
const yamlFiles = checkYamlFiles();

out(
  `docs:check: ${markdown.length} Markdown files, ${links} relative links, ${yamlFiles} YAML files parsed`,
);
out(
  `docs:check: ${tracker.labels} labels, ${tracker.milestones} milestones, ${tracker.issues} issues`,
);
if (errors.length > 0) {
  for (const e of errors) out(`  error: ${e}`);
  out(`docs:check: FAILED with ${errors.length} error(s)`);
  process.exit(1);
}
out('docs:check: OK');

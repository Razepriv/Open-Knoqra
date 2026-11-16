// Web budgets, the page registry and the pure pieces of `perf:web`: evaluating a Lighthouse
// result, median-of-N selection, detail extraction and report rendering. No I/O here.

export const WEB_BUDGETS = { lcpMs: 2000, cls: 0.05 } as const;

export type PageDef = { name: string; path: string; auth: boolean };

/** The screens measured. Other milestones append their pages here. */
export const PAGES: PageDef[] = [
  { name: 'sign-in', path: '/sign-in', auth: false },
  { name: 'contacts', path: '/contacts', auth: true },
  { name: 'contact360', path: '/contacts/{ids.heavy}', auth: true },
  { name: 'inbox', path: '/inbox', auth: true },
  { name: 'calls', path: '/calls', auth: true },
  { name: 'tasks', path: '/tasks', auth: true },
];

/** The slice of a Lighthouse result this tool reads; a real `LH.Result` satisfies it. */
export type LhrLike = {
  audits: Record<string, { numericValue?: number; details?: unknown } | undefined>;
  categories: Record<string, { score: number | null } | undefined>;
};

export type Evaluation = {
  lcpMs: number;
  cls: number;
  tbtMs: number;
  performanceScore: number;
  violations: string[];
};

const MISSING = Number.NaN;

function metric(lhr: LhrLike, audit: string): number {
  const value = lhr.audits[audit]?.numericValue;
  return typeof value === 'number' ? value : MISSING;
}

function performanceScore(lhr: LhrLike): number {
  const score = lhr.categories.performance?.score;
  return typeof score === 'number' ? Math.round(score * 100) : MISSING;
}

function violationsFor(name: string, lcpMs: number, cls: number): string[] {
  const violations: string[] = [];
  if (Number.isNaN(lcpMs)) {
    violations.push(`${name}: no LCP value in the Lighthouse result`);
  } else if (lcpMs > WEB_BUDGETS.lcpMs) {
    violations.push(
      `${name}: LCP ${(lcpMs / 1000).toFixed(2)} s is over ${(WEB_BUDGETS.lcpMs / 1000).toFixed(2)} s`,
    );
  }
  if (Number.isNaN(cls)) {
    violations.push(`${name}: no CLS value in the Lighthouse result`);
  } else if (cls > WEB_BUDGETS.cls) {
    violations.push(`${name}: CLS ${cls.toFixed(3)} is over ${WEB_BUDGETS.cls.toFixed(3)}`);
  }
  return violations;
}

/** One Lighthouse result against the budgets. A missing metric is a violation, never zero. */
export function evaluate(lhr: LhrLike, pageName = 'page'): Evaluation {
  const lcpMs = metric(lhr, 'largest-contentful-paint');
  const cls = metric(lhr, 'cumulative-layout-shift');
  return {
    lcpMs,
    cls,
    tbtMs: metric(lhr, 'total-blocking-time'),
    performanceScore: performanceScore(lhr),
    violations: violationsFor(pageName, lcpMs, cls),
  };
}

/** Middle value; the mean of the middle two for an even count. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as number;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] as number) + hi) / 2;
}

export type PageResult = Evaluation & {
  name: string;
  runs: number;
  /** The run whose LCP is the median; the detail sections come from it. */
  medianRun: LhrLike;
};

function medianOfFinite(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0 ? MISSING : median(finite);
}

/**
 * Median LCP, CLS, TBT and score over the runs, judged against the budgets. A run missing a
 * metric is left out of that metric's median and reported as a violation.
 */
export function aggregate<T extends LhrLike>(
  name: string,
  runs: readonly T[],
): PageResult & { medianRun: T } {
  if (runs.length === 0) throw new Error(`no Lighthouse runs for ${name}`);
  const evaluated = runs.map((run) => evaluate(run, name));
  const med = (pick: (e: Evaluation) => number) => medianOfFinite(evaluated.map(pick));
  const lcpMs = med((e) => e.lcpMs);
  const cls = med((e) => e.cls);
  // The run nearest the median LCP; for an odd count that is exactly the middle run.
  let nearest = Math.max(
    0,
    evaluated.findIndex((e) => Number.isFinite(e.lcpMs)),
  );
  evaluated.forEach((e, i) => {
    const best = evaluated[nearest] as Evaluation;
    if (Math.abs(e.lcpMs - lcpMs) < Math.abs(best.lcpMs - lcpMs)) nearest = i;
  });
  const runViolations = evaluated.flatMap((e, i) => [
    ...(Number.isFinite(e.lcpMs) ? [] : [`${name}: run ${i + 1} had no LCP`]),
    ...(Number.isFinite(e.cls) ? [] : [`${name}: run ${i + 1} had no CLS`]),
  ]);
  return {
    name,
    runs: runs.length,
    lcpMs,
    cls,
    tbtMs: med((e) => e.tbtMs),
    performanceScore: med((e) => e.performanceScore),
    violations: [...violationsFor(name, lcpMs, cls), ...runViolations],
    medianRun: runs[nearest] as T,
  };
}

// --- detail extraction -------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function describeNode(node: unknown): string | undefined {
  const n = asObject(node);
  if (n === undefined) return undefined;
  const where = [n.selector, n.snippet].find((v) => typeof v === 'string' && v !== '') as
    | string
    | undefined;
  if (where === undefined) return undefined;
  return typeof n.nodeLabel === 'string' && n.nodeLabel !== '' && n.nodeLabel !== where
    ? `${where} (${n.nodeLabel})`
    : where;
}

export type LcpDetail = { elements: string[]; phases: string[] };

/** The LCP element(s) and the phase breakdown from `largest-contentful-paint-element`. */
export function extractLcpElement(lhr: LhrLike): LcpDetail {
  const details = asObject(lhr.audits['largest-contentful-paint-element']?.details);
  const elements: string[] = [];
  const phases: string[] = [];
  for (const section of asArray(details?.items)) {
    for (const item of asArray(asObject(section)?.items)) {
      const row = asObject(item);
      if (row === undefined) continue;
      const element = describeNode(row.node);
      if (element !== undefined) elements.push(element);
      if (typeof row.phase === 'string' && typeof row.timing === 'number') {
        phases.push(`${row.phase} ${Math.round(row.timing)} ms`);
      }
    }
  }
  return { elements: elements.slice(0, 3), phases };
}

/** The top 3 layout shifts by score, from `layout-shifts`. */
export function extractLayoutShifts(lhr: LhrLike, limit = 3): string[] {
  const details = asObject(lhr.audits['layout-shifts']?.details);
  const shifts: { label: string; score: number }[] = [];
  for (const item of asArray(details?.items)) {
    const row = asObject(item);
    if (row === undefined || typeof row.score !== 'number') continue;
    shifts.push({ label: describeNode(row.node) ?? 'unknown element', score: row.score });
  }
  return shifts
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => `${s.label}: ${s.score.toFixed(4)}`);
}

// --- report ------------------------------------------------------------------------------------

export type BundleResult = {
  initialBytes: number;
  files: string[];
  violations: string[];
  sizes: Record<string, number>;
};

export type WebReportInput = {
  date: string;
  database: string;
  machine: string;
  bundle: BundleResult;
  pages: readonly PageResult[];
  /** Problems that stopped the run early (sign-in or Lighthouse failed); each counts as a FAIL. */
  failures?: readonly string[];
};

const KB = 1024;
const BUNDLE_BUDGET_KB = 200;

function bundleSection(bundle: BundleResult): string[] {
  return [
    '## Bundle budget',
    '',
    `Initial JS (entry plus static imports), gzipped; budget ${BUNDLE_BUDGET_KB} KB.`,
    '',
    '| File | KB gzipped |',
    '|---|---|',
    ...bundle.files.map((f) => `| ${f} | ${((bundle.sizes[f] ?? 0) / KB).toFixed(1)} |`),
    `| Total initial JS | ${(bundle.initialBytes / KB).toFixed(1)} |`,
    '',
  ];
}

function num(value: number, digits: number): string {
  return Number.isNaN(value) ? 'n/a' : value.toFixed(digits);
}

function pageDetail(page: PageResult): string[] {
  const lcp = extractLcpElement(page.medianRun);
  const shifts = extractLayoutShifts(page.medianRun);
  const list = (items: string[]) =>
    items.length > 0 ? items.map((i) => `- ${i}`) : ['- none reported'];
  return [
    `### ${page.name}`,
    '',
    'LCP element (median run):',
    ...list(lcp.elements),
    '',
    'LCP phases:',
    ...list(lcp.phases),
    '',
    'Top layout shifts:',
    ...list(shifts),
    '',
  ];
}

export function renderWebReport(input: WebReportInput): string {
  const failures = input.failures ?? [];
  const violations = [
    ...input.bundle.violations,
    ...input.pages.flatMap((p) => p.violations),
    ...failures,
  ];
  const pass = violations.length === 0;
  return `${[
    `# Web performance report ${input.date}`,
    '',
    `Overall: ${pass ? 'PASS' : `**FAIL** (${violations.length} problems)`}`,
    '',
    `- Database: ${input.database}`,
    `- Lighthouse desktop preset; median of ${input.pages[0]?.runs ?? 3} runs per page`,
    `- Budgets: LCP at most ${(WEB_BUDGETS.lcpMs / 1000).toFixed(2)} s, CLS at most ${WEB_BUDGETS.cls.toFixed(3)}, initial JS at most ${BUNDLE_BUDGET_KB} KB gzipped`,
    `- Machine: ${input.machine}`,
    '',
    ...violations.map((v) => `- **FAIL**: ${v}`),
    ...(pass ? [] : ['']),
    ...(failures.length > 0
      ? ['**Incomplete run**: the pages below are only those measured before the failure.', '']
      : []),
    ...bundleSection(input.bundle),
    '## Pages',
    '',
    '| Page | LCP s | CLS | TBT ms | Score | Result |',
    '|---|---|---|---|---|---|',
    ...input.pages.map(
      (p) =>
        `| ${p.name} | ${num(p.lcpMs / 1000, 2)} | ${num(p.cls, 3)} | ${num(p.tbtMs, 0)} | ${num(p.performanceScore, 0)} | ${p.violations.length === 0 ? 'PASS' : 'FAIL'} |`,
    ),
    '',
    '## Details',
    '',
    ...input.pages.flatMap(pageDetail),
  ].join('\n')}\n`;
}

// Writes the markdown explain report. Contains no paths or hostnames, and never inlines values.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PlanAnalysis } from './analyze';

export type StatementReport = PlanAnalysis & { sql: string; buffers: string };

/**
 * A ruling that lets a case run over its budget, up to a hard ceiling. Above `ceilingMs` the case
 * fails again, so a regression on an allowlisted path is still caught.
 */
export type OverBudgetAllowance = { reason: string; ceilingMs: number };

export type CaseResult = {
  name: string;
  milestone: string;
  budgetMs: number;
  httpStatus: number;
  statements: StatementReport[];
  notes: string[];
  problems: string[];
  /** Ruling when the case may run over budget, up to its ceiling; the time is still reported. */
  overBudgetAllowed?: OverBudgetAllowance;
};

export type ReportMeta = {
  date: string;
  database: string;
  platform: string;
  cpus: number;
  node: string;
  postgres: string;
  rows: string;
  /** Extra header lines, for example a warning that the seed holds earlier writes. */
  warnings?: string[];
  /** One-line reason the run aborted before every case finished; marks the report FAIL. */
  failure?: string;
};

const round = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export function dbMs(result: Pick<CaseResult, 'statements'>): number {
  return result.statements.reduce((sum, s) => sum + s.executionMs, 0);
}

/** True when the case ran over budget, but within the ceiling of an explicit ruling. */
export function isAllowedOverBudget(
  result: Pick<CaseResult, 'statements' | 'budgetMs' | 'overBudgetAllowed'>,
): boolean {
  const allowance = result.overBudgetAllowed;
  if (allowance === undefined) return false;
  const total = dbMs(result);
  return total > result.budgetMs && total <= allowance.ceilingMs;
}

function timeProblem(
  result: Pick<CaseResult, 'statements' | 'budgetMs' | 'overBudgetAllowed'>,
): string | undefined {
  const total = dbMs(result);
  if (total <= result.budgetMs) return undefined;
  const allowance = result.overBudgetAllowed;
  if (allowance === undefined) {
    return `over budget (${round(total)} ms > ${result.budgetMs} ms)`;
  }
  if (total > allowance.ceilingMs) {
    return `over allowlisted ceiling (${round(total)} ms > ${allowance.ceilingMs} ms)`;
  }
  return undefined;
}

/**
 * A case fails on a non-2xx response, an isolation or scan violation, or time over budget, unless
 * a ruling allows that case over budget (the time is still reported). An allowed case still fails
 * above the ruling's ceiling.
 */
export function caseProblems(
  result: Omit<CaseResult, 'problems' | 'notes'>,
  extra: string[],
): string[] {
  const problems = [...extra];
  if (result.httpStatus < 200 || result.httpStatus > 299) {
    problems.push(`HTTP ${result.httpStatus}`);
  }
  for (const s of result.statements) problems.push(...s.violations);
  const time = timeProblem(result);
  if (time !== undefined) problems.push(time);
  return problems;
}

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 160);

function partialLines(results: CaseResult[]): string[] {
  const partial = results.filter((r) => r.notes.length > 0).map((r) => r.name);
  if (partial.length === 0) return [];
  return [
    `- Partial: ${partial.join(', ')} committed writes, so the replay hit unique-key conflicts on ` +
      're-insert (R5) and skipped those statements; their DB ms covers the rest only',
  ];
}

export function renderReport(results: CaseResult[], meta: ReportMeta): string {
  const failed = results.filter((r) => r.problems.length > 0);
  const overall = meta.failure
    ? '**FAIL** (run aborted)'
    : failed.length === 0
      ? 'PASS'
      : `**FAIL** (${failed.length} of ${results.length} cases)`;
  const lines: string[] = [
    `# Explain report ${meta.date}`,
    '',
    `Overall: ${overall}`,
    '',
    `- Database: ${meta.database} (${meta.rows})`,
    `- Machine: ${meta.platform}, ${meta.cpus} CPUs, Node ${meta.node}, PostgreSQL ${meta.postgres}`,
    '- Role: knoqra_app with RLS, EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) per captured statement',
    ...partialLines(results),
    ...(meta.warnings ?? []).map((w) => `- ${w}`),
    ...(meta.failure ? [`- **FAIL**: ${meta.failure}`] : []),
    '',
    '| Case | Milestone | Status | DB ms | Budget ms | Statements | Seq scans |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const passed = r.problems.length === 0;
    const status = !passed ? '**FAIL**' : isAllowedOverBudget(r) ? 'PASS (allowlisted)' : 'PASS';
    const scans = [...new Set(r.statements.flatMap((s) => s.seqScans))];
    lines.push(
      `| ${r.name} | ${r.milestone} | ${status} | ${round(dbMs(r))} | ${r.budgetMs} | ${r.statements.length} | ${scans.length === 0 ? '-' : scans.join(', ')} |`,
    );
  }
  for (const r of results) {
    lines.push('', `## ${r.name}`, '');
    for (const p of r.problems) lines.push(`- **FAIL**: ${p}`);
    if (isAllowedOverBudget(r)) {
      lines.push(
        `- Allowlisted over budget (${round(dbMs(r))} ms > ${r.budgetMs} ms, ceiling ${r.overBudgetAllowed?.ceilingMs} ms): ${r.overBudgetAllowed?.reason}`,
      );
    }
    for (const n of r.notes) lines.push(`- Note: ${n}`);
    r.statements.forEach((s, i) => {
      lines.push(
        `${i + 1}. \`${collapse(s.sql).replaceAll('`', "'")}\``,
        `   - ${round(s.executionMs)} ms, planning ${round(s.planningMs)} ms, buffers ${s.buffers}`,
        `   - ${s.nodes.join(' > ')}`,
      );
    });
  }
  return `${lines.join('\n')}\n`;
}

export function writeReport(file: string, results: CaseResult[], meta: ReportMeta): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderReport(results, meta));
}

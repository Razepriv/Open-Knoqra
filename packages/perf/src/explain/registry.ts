// The explain case registry. To add a case for a milestone, append an entry to EXPLAIN_CASES:
//   1. set `milestone` (for example 'M2'),
//   2. write `path` (and string values in `body`) with fixtures placeholders such as
//      {ids.heavy} or {cursors.contactsDeep}; they resolve against .perf/fixtures.json
//      (a body value `{ $fixture: 'some.path' }` inserts that fixtures value as-is, arrays included),
//   3. give a `budgetMs` for the database time of the whole request,
//   4. set `mutates: true` if the request writes (it commits; re-run perf:seed --reset after),
//   5. only if a sequential scan is accepted, add `allowSeqScan` with the table and a reason,
//   6. only under a recorded ruling, add `allowOverBudget` with its reason and a `ceilingMs`; the
//      report still prints the measured time and marks the case "PASS (allowlisted)", and the
//      case fails again above the ceiling.
// Every case runs as owner A of the seeded organization.
import { fillTemplate } from '../fixtures-template';
import type { Fixtures } from '../seed/fixtures';
import { PHASE1_CASES } from './phase1-cases';
import type { OverBudgetAllowance } from './report';

export type ExplainCase = {
  name: string;
  milestone: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  budgetMs: number;
  mutates?: boolean;
  allowSeqScan?: { table: string; reason: string }[];
  allowOverBudget?: OverBudgetAllowance;
};

const R2_SEARCH = [{ table: 'contact', reason: 'R2: substring search under RLS' }];

export const EXPLAIN_CASES: readonly ExplainCase[] = [
  {
    name: 'contacts.list.first',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts?limit=50',
    budgetMs: 50,
  },
  {
    name: 'contacts.list.deep',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts?limit=50&cursor={cursors.contactsDeep}',
    budgetMs: 50,
  },
  {
    name: 'contacts.list.archived',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts?archived=true&limit=50',
    budgetMs: 50,
  },
  ...(['name', 'company', 'email', 'digits', 'rare'] as const).map(
    (key): ExplainCase => ({
      name: `contacts.search.${key}`,
      milestone: 'M1',
      method: 'GET',
      path: `/api/v1/contacts?q={search.${key}}`,
      budgetMs: 150,
      allowSeqScan: R2_SEARCH,
    }),
  ),
  {
    name: 'contacts.detail',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.middle}',
    budgetMs: 20,
  },
  {
    name: 'timeline.first',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.heavy}/timeline?limit=50',
    budgetMs: 50,
  },
  {
    name: 'timeline.deep',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.heavy}/timeline?limit=50&cursor={cursors.timelineDeep}',
    budgetMs: 50,
  },
  {
    name: 'timeline.calls',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.heavy}/timeline?kind=calls',
    budgetMs: 50,
  },
  {
    name: 'timeline.notes_consent',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.heavy}/timeline?kind=notes_consent',
    budgetMs: 50,
  },
  {
    name: 'permissions',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.middle}/permissions',
    budgetMs: 20,
  },
  {
    name: 'duplicates',
    milestone: 'M1',
    method: 'GET',
    path: '/api/v1/contacts/{ids.withDuplicates}/duplicates',
    budgetMs: 50,
  },
  {
    name: 'import.upsert',
    milestone: 'M1',
    method: 'POST',
    path: '/api/v1/contacts/import',
    body: {
      fileName: 'perf-import.csv',
      onDuplicate: 'update',
      rows: { $fixture: 'importRows' },
    },
    budgetMs: 150,
    mutates: true,
  },
  ...PHASE1_CASES,
];

/** A body value `{ $fixture: 'importRows' }` is replaced by that fixtures path's raw value. */
function fixtureRef(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const ref = (value as Record<string, unknown>).$fixture;
  return keys.length === 1 && typeof ref === 'string' ? ref : null;
}

function rawFixture(fixtures: Fixtures, path: string): unknown {
  let current: unknown = fixtures;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) {
      throw new Error(`unknown placeholder {${path}}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Recursively templates string values of a body and resolves `$fixture` references. */
export function fillBody(value: unknown, fixtures: Fixtures): unknown {
  const ref = fixtureRef(value);
  if (ref !== null) return rawFixture(fixtures, ref);
  if (typeof value === 'string') return fillTemplate(value, fixtures);
  if (Array.isArray(value)) return value.map((v) => fillBody(v, fixtures));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillBody(v, fixtures)]));
  }
  return value;
}

/** Resolves a case's path and body against the fixtures. */
export function resolveCase(c: ExplainCase, fixtures: Fixtures): { path: string; body: unknown } {
  return {
    path: fillTemplate(c.path, fixtures),
    body: c.body === undefined ? undefined : fillBody(c.body, fixtures),
  };
}

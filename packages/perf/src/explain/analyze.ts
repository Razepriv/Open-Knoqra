// Reads an EXPLAIN (FORMAT JSON) plan: timings, sequential scans on large tables, node list.
import type { ExplainCase } from './registry';

export type PlanAnalysis = {
  executionMs: number;
  planningMs: number;
  seqScans: string[];
  violations: string[];
  nodes: string[];
};

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };

function describeNode(node: PlanNode): string {
  const type = String(node['Node Type']);
  const index = node['Index Name'];
  const relation = node['Relation Name'];
  if (typeof index === 'string') return `${type} using ${index}`;
  if (typeof relation === 'string') return `${type} on ${relation}`;
  return type;
}

/** Walks the plan tree and reports sequential scans that are not allowed on large tables. */
export function analyzePlan(
  plan: unknown,
  largeTables: ReadonlySet<string>,
  allow: ExplainCase['allowSeqScan'],
): PlanAnalysis {
  const root = (Array.isArray(plan) ? plan[0] : plan) as Record<string, unknown>;
  const seqScans: string[] = [];
  const violations: string[] = [];
  const nodes: string[] = [];
  const allowed = new Set((allow ?? []).map((a) => a.table));

  const walk = (node: PlanNode): void => {
    nodes.push(describeNode(node));
    const relation = node['Relation Name'];
    if (node['Node Type'] === 'Seq Scan' && typeof relation === 'string') {
      seqScans.push(relation);
      if (largeTables.has(relation) && !allowed.has(relation)) {
        violations.push(`seq scan on ${relation}`);
      }
    }
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root.Plan as PlanNode);

  return {
    executionMs: Number(root['Execution Time'] ?? 0),
    planningMs: Number(root['Planning Time'] ?? 0),
    seqScans,
    violations,
    nodes,
  };
}

const ISOLATION_KEYS = new Set(['id', 'contactId', 'organizationId']);

type FoundId = { key: string; value: string };

/** Every string under the keys id, contactId and organizationId, at any depth. */
export function collectIds(value: unknown, found: FoundId[] = []): FoundId[] {
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, found);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (ISOLATION_KEYS.has(k) && typeof v === 'string') found.push({ key: k, value: v });
      else collectIds(v, found);
    }
  }
  return found;
}

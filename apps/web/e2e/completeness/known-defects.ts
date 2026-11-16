/**
 * Crawler findings that are known and routed to someone but not fixed yet. The crawler reports a
 * matching problem as "known, routed" instead of failing. Each entry covers one control and one
 * kind of problem, and names its issue in `ticket`. Keep it short-lived: delete an entry when its
 * fix lands, and empty the list before a milestone closes (it is empty now).
 */
export interface KnownDefect {
  /** The route target label (`/contacts/$contactId (full)`) or its pattern (`/contacts/$contactId`). */
  target: string;
  /** Limit to one viewport; omit for both. */
  viewport?: 'desktop' | 'phone';
  /** The control as the crawler names it: `button "Save"`, `menuitem "Edit contact"`, or `page`. */
  control: string;
  problem: RegExp;
  /** The routed issue, e.g. `#123 <short title>`. */
  ticket: string;
}

export interface CrawlProblem {
  target: string;
  viewport: 'desktop' | 'phone';
  control: string;
  problem: string;
}

export const KNOWN_DEFECTS: readonly KnownDefect[] = [];

function targetMatches(defect: string, target: string): boolean {
  return defect === target || target.startsWith(`${defect} (`);
}

function controlMatches(defect: string, control: string): boolean {
  return defect === control || control.startsWith(`${defect} (in `);
}

export function findKnownDefect(
  found: CrawlProblem,
  defects: readonly KnownDefect[] = KNOWN_DEFECTS,
): KnownDefect | undefined {
  return defects.find(
    (d) =>
      targetMatches(d.target, found.target) &&
      (d.viewport === undefined || d.viewport === found.viewport) &&
      controlMatches(d.control, found.control) &&
      d.problem.test(found.problem),
  );
}

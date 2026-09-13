/**
 * Coverage check — PURE deterministic code, NO LLM anywhere in this module.
 *
 * Given extracted requirements and generated questions, compute which
 * PRIORITY-"must" requirements have zero questions referencing them.
 * Only "must" matters: a "nice" requirement left unasked is acceptable and
 * honest; an uncovered "must" is a real gap the second-pass loop must close.
 */
import type { Question, Requirement } from "../types";

export interface CoverageInput {
  requirements: Requirement[];
  questions: Question[];
}

export interface CoverageResult {
  /** requirement ids (priority "must") with zero questions referencing them. */
  uncovered_requirement_ids: string[];
  /** total number of second-pass iterations performed by the orchestrator. */
  passes: number;
}

/** Pure. Deterministic. No I/O. */
export function computeUncovered({ requirements, questions }: CoverageInput): string[] {
  const covered = new Set<string>();
  for (const q of questions) {
    for (const id of q.requirement_ids) covered.add(id);
  }
  return requirements
    .filter((r) => r.priority === "must" && !covered.has(r.id))
    .map((r) => r.id)
    .sort();
}

export function emptyCoverage(): CoverageResult {
  return { uncovered_requirement_ids: [], passes: 0 };
}

/** Build a CoverageResult with the caller's pass count from the pure check. */
export function coverageResult({ requirements, questions }: CoverageInput, passes: number): CoverageResult {
  return { uncovered_requirement_ids: computeUncovered({ requirements, questions }), passes };
}
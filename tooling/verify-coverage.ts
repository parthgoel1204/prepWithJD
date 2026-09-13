/**
 * Coverage check unit tests — PURE, no network, no LLM.
 * Run: npx tsx tooling/verify-coverage.ts
 */
import { computeUncovered, coverageResult } from "../packages/pipeline/src/coverage/index";
import type { Question, Requirement } from "../packages/pipeline/src/types";

function req(id: string, priority: "must" | "nice" = "must"): Requirement {
  return { id, text: `requirement ${id}`, kind: "technical", priority };
}
function q(id: string, requirement_ids: string[]): Question {
  return {
    id,
    requirement_ids,
    category: "technical",
    prompt: `question ${id}`,
    answer_outline: "key point",
    difficulty: 2,
  };
}

let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failCount++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
}

const musts = [req("r1"), req("r2", "must"), req("r3", "nice")];

// every must covered
check("all musts covered -> empty uncovered", computeUncovered({ requirements: musts, questions: [q("q1", ["r1", "r2"])] }).length === 0);

// r2 (must) missed, r3 (nice) missed -> only r2 reported
const uncovered = computeUncovered({
  requirements: musts,
  questions: [q("q1", ["r1", "r3"])],
});
check("nice-only misses are not gaps", JSON.stringify(uncovered) === JSON.stringify(["r2"]));

// duplicates in question requirement_ids collapse
const dup = computeUncovered({ requirements: musts, questions: [q("q1", ["r2", "r2", "r2", "r1"])] });
check("duplicate ids in a question count once", dup.length === 0);

// zero questions -> all musts uncovered, sorted
const none = computeUncovered({ requirements: musts, questions: [] });
check("zero questions flags every must", JSON.stringify(none) === JSON.stringify(["r1", "r2"]));

// deterministic order regardless of input order
const shuffled = computeUncovered({ requirements: [req("r9"), req("r3", "nice"), req("r2")], questions: [] });
check("deterministic sorted output", JSON.stringify(shuffled) === JSON.stringify(["r2", "r9"]));

// coverageResult carries the pass count
const res = coverageResult({ requirements: musts, questions: [q("q1", ["r1", "r2"])] }, 2);
check("coverageResult records passes", res.passes === 2 && res.uncovered_requirement_ids.length === 0);

console.log(`\n=== coverage verify: ${failCount === 0 ? "all passed" : `${failCount} FAILED`} ===`);
process.exit(failCount ? 1 : 0);
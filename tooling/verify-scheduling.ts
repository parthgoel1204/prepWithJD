/**
 * Scheduling unit tests — PURE, no network, no LLM.
 * Run: npx tsx tooling/verify-scheduling.ts
 */
import { buildSchedule, minutesForText, minutesForQuestion, sortByScheduleOrder } from "../packages/pipeline/src/scheduling/index";
import type { Question, Requirement } from "../packages/pipeline/src/types";

let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failCount++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
}

const requirements: Requirement[] = [
  { id: "r1", text: "Go required", kind: "technical", priority: "must" },
  { id: "r2", text: "Postgres", kind: "technical", priority: "must" },
  { id: "r3", text: "Bonus: Kafka", kind: "technical", priority: "nice" },
];
const words5 = "a a a a a"; // 5 words -> ceil(5/40)=1
const words120 = Array.from({ length: 120 }, () => "a").join(" "); // -> 3
const q = (id: string, reqIds: string[], difficulty: number, category: Question["category"], outline: string): Question => ({
  id,
  requirement_ids: reqIds,
  category,
  prompt: `prompt ${id}`,
  answer_outline: outline,
  difficulty,
});

function dayIds(schedule: ReturnType<typeof buildSchedule>): string[] {
  return schedule.days.flatMap((d) => d.question_ids);
}

// --- minutes estimation (length-based, the user's decision) ---
check("minutes: empty text -> 0", minutesForText("") === 0);
check("minutes: 5 words -> 1", minutesForText(words5) === 1);
check("minutes: 120 words -> 3", minutesForText(words120) === 3, minutesForText(words120));
check("minutes: uses answer_outline", minutesForQuestion(q("q1", ["r1"], 1, "technical", words120)) === 3);

// --- sort: must-linked first, then difficulty desc, then id asc ---
const unsorted = [
  q("q3", ["r3"], 3, "behavioural", words5), // nice-only, hard
  q("q2", ["r2"], 1, "technical", words5), // must, easy
  q("q1", ["r1"], 2, "technical", words5), // must, mid
];
const sorted = sortByScheduleOrder(unsorted, requirements);
check("sort: must first, then difficulty desc, then id", sorted.map((x) => x.id).join(",") === "q1,q2,q3", sorted.map((x) => x.id).join(","));

// --- days=1: everything lands on day 1, exactly one entry ---
const one = buildSchedule(requirements, [q("q1", ["r1"], 3, "technical", words120), q("q2", ["r2"], 2, "technical", words120), q("q3", ["r3"], 1, "behavioural", words5)], 1);
check("days=1: exactly 1 day entry", one.days.length === 1);
check("days=1: day1 holds all questions", dayIds(one).sort().join(",") === "q1,q2,q3");
check("days=1: minutes totals all 3 + 3 + 1 = 7", one.days[0]!.minutes === 7, one.days[0]!.minutes);

// --- days=60 with 3 questions: exactly 60 entries, front-loaded ---
const sixty = buildSchedule(requirements, [q("q1", ["r1"], 3, "technical", words5), q("q2", ["r2"], 2, "technical", words5), q("q3", ["r3"], 1, "behavioural", words5)], 60);
check("days=60: exactly 60 day entries", sixty.days.length === 60, `days=${sixty.days.length}`);
check("days=60: all 3 questions scheduled exactly once", dayIds(sixty).sort().join(",") === "q1,q2,q3");
check("days=60: only first days carry questions (front-loaded)", sixty.days[0]!.minutes > 0 && sixty.days[59]!.minutes === 0, `d1=${sixty.days[0]!.minutes} d60=${sixty.days[59]!.minutes}`);
check("days=60: empty days flagged as buffer", sixty.days[59]!.focus === "Review / light day", sixty.days[59]!.focus);
check("days=60: total minutes = sum of question minutes (1+1+1)", sixty.days.reduce((s, d) => s + d.minutes, 0) === 3, `total=${sixty.days.reduce((s, d) => s + d.minutes, 0)}`);

// --- zero questions ---
const zero = buildSchedule(requirements, [], 7);
check("zero questions: still exactly 7 day entries", zero.days.length === 7 && zero.days.every((d) => d.minutes === 0 && d.question_ids.length === 0), `days=${zero.days.length}`);

// --- old-day-1 jack: must-linked question lands on day 1 even when a nice one is harder ---
const front = buildSchedule(requirements, [q("q_nice_hard", ["r3"], 3, "technical", words5), q("q_must_easy", ["r1"], 1, "technical", words5)], 1);
check("front-load: must question comes before nice even if easier", front.days[0]!.question_ids[0] === "q_must_easy", front.days[0]!.question_ids.join(","));

// --- determinism ---
const a = buildSchedule(requirements, unsorted, 40);
const b = buildSchedule(requirements, unsorted, 40);
check("determinism: identical output across calls", JSON.stringify(a) === JSON.stringify(b));

console.log(`\n=== scheduling verify: ${failCount === 0 ? "all passed" : `${failCount} FAILED`} ===`);
process.exit(failCount ? 1 : 0);
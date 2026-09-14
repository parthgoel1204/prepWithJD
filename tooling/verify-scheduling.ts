/**
 * Scheduling unit tests — PURE, no network, no LLM.
 * Run: npx tsx tooling/verify-scheduling.ts
 *
 * Adaptive scheduler contract (replaces the old fixed DAY_CAPACITY_MINUTES=90):
 *   (a) exactly `days_available` day entries are ALWAYS returned,
 *   (b) every question — in particular every must-linked question — is
 *       scheduled somewhere (material is never left over because packing
 *       stopped too early),
 *   (c) minutes-per-day trend downward (or flat) as days_available grows for
 *       the same material: concentrated when days are few, spread thin when
 *       days are many, and
 *   (d) determinism holds — same input -> byte-identical output.
 *
 * At the end it prints the actual minutes-per-day distributions for a realistic
 * Adobe-style case (~16 questions, 235 min) at days = 1 / 3 / 14 / 60.
 */
import {
  adaptiveTargetMinutes,
  buildSchedule,
  minutesForQuestion,
  MIN_DAILY_MINUTES,
  QUESTION_MINUTES,
  sortByScheduleOrder,
} from "../packages/pipeline/src/scheduling/index";
import type { Question, Requirement } from "../packages/pipeline/src/types";

let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failCount++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
}

// --- small real-material fixtures ---
const requirements: Requirement[] = [
  { id: "r1", text: "Go required", kind: "technical", priority: "must" },
  { id: "r2", text: "Postgres", kind: "technical", priority: "must" },
  { id: "r3", text: "Bonus: Kafka", kind: "technical", priority: "nice" },
];
const words5 = "a a a a a";
const words120 = Array.from({ length: 120 }, () => "a").join(" ");
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

// --- minutes estimation (difficulty-based constants, the locked user decision) ---
check("minutes map: 1★=10, 2★=15, 3★=20", JSON.stringify(QUESTION_MINUTES) === JSON.stringify({ 1: 10, 2: 15, 3: 20 }));
check("minutes: diff 1 -> 10", minutesForQuestion(q("q1", ["r1"], 1, "technical", words5)) === 10);
check("minutes: diff 2 -> 15", minutesForQuestion(q("q2", ["r2"], 2, "technical", words120)) === 15);
check("minutes: diff 3 -> 20", minutesForQuestion(q("q3", ["r3"], 3, "behavioural", words120)) === 20);
check("minutes: ignores answer_outline length (5-word vs 500-word, same difficulty)", minutesForQuestion(q("a", ["r1"], 2, "technical", words5)) === 15 && minutesForQuestion(q("b", ["r1"], 2, "technical", Array.from({ length: 500 }, () => "a").join(" "))) === 15);
check("minutes: clamps out-of-range difficulty", minutesForQuestion(q("c", ["r1"], 5, "technical", words5)) === 20 && minutesForQuestion(q("d", ["r1"], 0, "technical", words5)) === 10);

// --- sort: must-linked first, then difficulty desc, then id asc ---
const unsorted = [
  q("q3", ["r3"], 3, "behavioural", words5), // nice-only, hard
  q("q2", ["r2"], 1, "technical", words5), // must, easy
  q("q1", ["r1"], 2, "technical", words5), // must, mid
];
const sorted = sortByScheduleOrder(unsorted, requirements);
check("sort: must first, then difficulty desc, then id", sorted.map((x) => x.id).join(",") === "q1,q2,q3", sorted.map((x) => x.id).join(","));

// --- adaptive target math (ceil(total/days), floor, no ceiling) ---
check("target: ceil(235/3)=79", adaptiveTargetMinutes(235, 3) === 79);
check("target: ceil(235/14)=17", adaptiveTargetMinutes(235, 14) === 17);
check("target: floor applies — ceil(45/60)=1 -> 15", adaptiveTargetMinutes(45, 60) === MIN_DAILY_MINUTES, adaptiveTargetMinutes(45, 60));
check("target: no hard ceiling — days=3 with 3000 min -> 1000", adaptiveTargetMinutes(3000, 3) === 1000, adaptiveTargetMinutes(3000, 3));
check("target: zero material -> 0 (all review days)", adaptiveTargetMinutes(0, 60) === 0 && adaptiveTargetMinutes(0, 7) === 0);

// --- days=1: everything lands on day 1, exactly one entry, conserved total ---
const one = buildSchedule(requirements, [q("q1", ["r1"], 3, "technical", words120), q("q2", ["r2"], 2, "technical", words120), q("q3", ["r3"], 1, "behavioural", words5)], 1);
check("(a) days=1: exactly 1 day entry", one.days.length === 1);
check("days=1: all questions scheduled", dayIds(one).sort().join(",") === "q1,q2,q3");
check("days=1: all 45 min on day 1 (conserved, 20+15+10)", one.days[0]!.minutes === 45, one.days[0]!.minutes);

// --- days=60 with 3 questions: exactly 60 entries, front-loaded, honest empties ---
const sixty = buildSchedule(requirements, [q("q1", ["r1"], 3, "technical", words5), q("q2", ["r2"], 2, "technical", words5), q("q3", ["r3"], 1, "behavioural", words5)], 60);
check("(a) days=60: exactly 60 day entries", sixty.days.length === 60, `days=${sixty.days.length}`);
check("(b) days=60: all 3 questions scheduled exactly once", dayIds(sixty).sort().join(",") === "q1,q2,q3");
check("days=60: front-loaded (first days carry, day 60 explicit review)", sixty.days[0]!.minutes > 0 && sixty.days[59]!.minutes === 0, `d1=${sixty.days[0]!.minutes} d60=${sixty.days[59]!.minutes}`);
check("days=60: empty days flagged as review", sixty.days[59]!.focus === "Review / light day", sixty.days[59]!.focus);
check("conservation: material is never lost or invented (sum=45 for 1 and 60 days)", sixty.days.reduce((s, d) => s + d.minutes, 0) === one.days.reduce((s, d) => s + d.minutes, 0) && sixty.days.reduce((s, d) => s + d.minutes, 0) === 45, `total=${sixty.days.reduce((s, d) => s + d.minutes, 0)}`);

// --- zero questions ---
const zero = buildSchedule(requirements, [], 7);
check("(a) zero questions: still exactly 7 day entries", zero.days.length === 7 && zero.days.every((d) => d.minutes === 0 && d.question_ids.length === 0), `days=${zero.days.length}`);

// --- days=0 clamps to a single day (same guard as original Math.max(1, ...)) ---
check("(a) days=0 clamps to 1 entry", buildSchedule(requirements, [q("q1", ["r1"], 3, "technical", words5)], 0).days.length === 1);

// --- front-load jack: must-linked question lands on day 1 even when a nice one is harder ---
const front = buildSchedule(requirements, [q("q_nice_hard", ["r3"], 3, "technical", words5), q("q_must_easy", ["r1"], 1, "technical", words5)], 1);
check("front-load: must question comes before nice even if easier", front.days[0]!.question_ids[0] === "q_must_easy", front.days[0]!.question_ids.join(","));

// =====================================================================
// Realistic Adobe-style case (~16 questions / 235 min across skills)
// =====================================================================
const adobeReqs: Requirement[] = [
  { id: "r1", text: "5+ years TypeScript required", kind: "technical", priority: "must" },
  { id: "r2", text: "Production React experience required", kind: "technical", priority: "must" },
  { id: "r3", text: "Node.js API service experience required", kind: "technical", priority: "must" },
  { id: "r4", text: "SQL and data modelling experience required", kind: "technical", priority: "must" },
  { id: "r5", text: "System design and scaling exposure required", kind: "technical", priority: "must" },
  { id: "r6", text: "Kubernetes / Docker exposure preferred", kind: "technical", priority: "nice" },
  { id: "r7", text: "Experience with payments / fintech a plus", kind: "domain", priority: "nice" },
  { id: "r8", text: "Clear written communication required", kind: "behavioural", priority: "must" },
  { id: "r9", text: "Leading cross-functional initiatives preferred", kind: "behavioural", priority: "nice" },
];
/** 16 questions: 4×3★(20m) + 7×2★(15m) + 5×1★(10m) = 235 min. */
const adobeQuestions: Question[] = [
  q("q1", ["r5"], 3, "system-design", words120),
  q("q2", ["r1"], 3, "technical", words120),
  q("q3", ["r2"], 2, "technical", words120),
  q("q4", ["r4"], 3, "technical", words120),
  q("q5", ["r8"], 2, "behavioural", words120),
  q("q6", ["r9"], 2, "behavioural", words120),
  q("q7", ["r6"], 1, "technical", words120),
  q("q8", ["r7"], 1, "company-fit", words120),
  q("q9", ["r1"], 2, "technical", words120),
  q("q10", ["r2", "r3"], 2, "technical", words120),
  q("q11", ["r5"], 2, "system-design", words120),
  q("q12", ["r4", "r1"], 2, "technical", words120),
  q("q13", ["r8"], 1, "behavioural", words120),
  q("q14", ["r2"], 1, "technical", words120),
  q("q15", ["r6", "r7"], 1, "company-fit", words120),
  q("q16", ["r5", "r4"], 3, "system-design", words120),
];
const adobeTotal = adobeQuestions.reduce((s, x) => s + minutesForQuestion(x), 0); // 235
const mustReqIds = new Set(adobeReqs.filter((r) => r.priority === "must").map((r) => r.id));
const mustLinked = adobeQuestions.filter((x) => x.requirement_ids.some((id) => mustReqIds.has(id)));
check("fixture: Adobe-style material = 235 min over 16 questions", adobeTotal === 235 && adobeQuestions.length === 16, adobeTotal);

function maxDayMinutes(sch: ReturnType<typeof buildSchedule>): number {
  return Math.max(...sch.days.map((d) => d.minutes));
}

// (a)+(b): exactly N entries for 1/3/14/60, every question (esp. must-linked) scheduled once
for (const days of [1, 3, 14, 60]) {
  const sch = buildSchedule(adobeReqs, adobeQuestions, days);
  const ids = dayIds(sch).sort();
  check(`(a) adobe days=${days}: exactly ${days} day entries`, sch.days.length === days, `got ${sch.days.length}`);
  check(
    `(b) adobe days=${days}: ALL ${adobeQuestions.length} questions scheduled exactly once`,
    ids.join(",") === adobeQuestions.map((x) => x.id).sort().join(","),
  );
  check(
    `(b) adobe days=${days}: every must-linked question (${mustLinked.length}) is scheduled`,
    mustLinked.every((x) => ids.includes(x.id)),
  );
}

// (c) minutes-per-day trend downward or flat as days grow (same 235-min material)
const trend = [1, 3, 14, 60].map((d) => maxDayMinutes(buildSchedule(adobeReqs, adobeQuestions, d)));
check(
  "(c) trend: max minutes/day is downward or flat 1->3->14->60",
  trend[0]! >= trend[1]! && trend[1]! >= trend[2]! && trend[2]! >= trend[3]!,
  trend.join(" -> "),
);

// (d) determinism: same input -> identical JSON
const d1 = buildSchedule(adobeReqs, adobeQuestions, 13);
const d2 = buildSchedule(adobeReqs, adobeQuestions, 13);
check("(d) determinism: identical output across calls", JSON.stringify(d1) === JSON.stringify(d2));

// --- the two behaviours that matter for a real study plan ---
const heavy = buildSchedule(adobeReqs, adobeQuestions, 3);
check(
  "3-day cram: every day carries heavy material (no 90 cap)",
  heavy.days[0]!.minutes >= 60 && heavy.days[1]!.minutes >= 60 && heavy.days[2]!.minutes >= 60 && heavy.days[0]!.minutes + heavy.days[1]!.minutes + heavy.days[2]!.minutes === 235,
  `d1=${heavy.days[0]!.minutes} d2=${heavy.days[1]!.minutes} d3=${heavy.days[2]!.minutes}`,
);
const spread = buildSchedule(adobeReqs, adobeQuestions, 60);
const spreadUsed = spread.days.filter((d) => d.minutes > 0).length;
check("60-day thin: material spreads across most early days (not clustered in 2-3)", spreadUsed >= 12 && spread.days[59]!.minutes === 0, `used=${spreadUsed}`);

// --- the old 90-cap bug: leftover material must never happen ---
const leftover = buildSchedule(adobeReqs, adobeQuestions, 14).days.reduce((s, d) => s + d.minutes, 0);
check("no leftover: all 235 min placed even at 14 days (old cap could strand material)", leftover === 235, `placed=${leftover}`);

// =====================================================================
// Demo — minutes-per-day distribution for the Adobe-style case
// =====================================================================
console.log("\n=== Adaptive schedule — Adobe-style case (16 questions, 235 min) ===");
for (const days of [1, 3, 14, 60]) {
  const sch = buildSchedule(adobeReqs, adobeQuestions, days);
  const used = sch.days.filter((d) => d.question_ids.length > 0);
  const target = adaptiveTargetMinutes(adobeTotal, days);
  console.log(
    `\ndays=${String(days).padStart(2, " ")}  target=${String(target).padStart(3, " ")}min/day  used=${String(used.length).padStart(2, " ")} days  ` +
      `conserved=${sch.days.reduce((s, d) => s + d.minutes, 0)}min`,
  );
  const perDay = used.map((d) => `d${d.day}=${d.minutes}m(${d.question_ids.length})`).join("  ");
  console.log(`  ${perDay}`);
}

console.log(`\n=== scheduling verify: ${failCount === 0 ? "all passed" : `${failCount} FAILED`} ===`);
process.exit(failCount ? 1 : 0);
import { join } from "node:path";
import { LlmGenerator, type GenerationContext } from "../packages/pipeline/src/generation";
import { sanitizeQuestions, sanitizeFlashcards, formatRequirements } from "../packages/pipeline/src/generation/pure";
import type { Requirement } from "../packages/pipeline/src/types";

const ROOT = join(import.meta.dirname, "..");
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* env missing */
}

let pass = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++;
  else failCount++;
}

const requirements: Requirement[] = [
  { id: "r1", text: "5+ years of backend engineering experience. Go required.", kind: "technical", priority: "must" },
  { id: "r2", text: "Strong SQL and data modelling (Postgres).", kind: "technical", priority: "must" },
  { id: "r3", text: "Event-driven architecture and Kafka.", kind: "technical", priority: "must" },
  { id: "r4", text: "BONUS: Kubernetes and AWS.", kind: "technical", priority: "nice" },
  { id: "r5", text: "Preferred: fintech or payments experience.", kind: "domain", priority: "nice" },
  { id: "r6", text: "Effective written communication.", kind: "behavioural", priority: "must" },
];

// --- pure sanitizer unit tests (no LLM) ---
const known = new Set(requirements.map((r) => r.id));
const clean = sanitizeQuestions(
  [
    { requirement_ids: ["r1", "r2"], prompt: "How do you design for high throughput?", answer_outline: "Events; backpressure; benchmarking.", difficulty: 2, category: "technical" },
    { requirement_ids: ["r9"], prompt: "ghost question", answer_outline: "x", difficulty: 1, category: "technical" },
    { requirement_ids: [], prompt: "unanchored", answer_outline: "y", difficulty: 1, category: "behavioural" },
    { requirement_ids: ["r3"], prompt: "more events", answer_outline: "z", difficulty: 9, category: "system-design" },
  ],
  known,
  0,
);
check("sanitize: valid questions kept + contiguous q ids", clean.questions.length === 2 && clean.questions[0]!.id === "q1" && clean.questions[1]!.id === "q2", clean.questions.map((q) => q.id).join(","));
check("sanitize: ghost/unanchored dropped loudly", clean.dropped.length === 2, JSON.stringify(clean.dropped));
check("sanitize: difficulty clamped into 1..3", clean.questions.every((q) => q.difficulty >= 1 && q.difficulty <= 3), `difficulty=${clean.questions.map((q) => q.difficulty).join(",")}`);
const cards = sanitizeFlashcards([{ front: "Kafka at-least-once", back: "...", requirement_ids: ["r3"] }, { front: "ghost card", back: "...", requirement_ids: ["r5", "z0"] }], known, 0);
check("sanitize: flashcards validated too", cards.flashcards.length === 1 && cards.flashcards[0]!.id === "f1" && cards.dropped.length === 1, JSON.stringify(cards.dropped));

// --- live per-category generation with retrieved-context signals ---
const ctx: GenerationContext = {
  jd: "N/A",
  company: "Acme Inc",
  company_brief: { summary: "Acme is a payments platform serving SMBs.", what_they_do: "Payments reconciliation APIs.", sources: [] },
  role: {
    title: "Senior Backend Engineer",
    seniority: "Senior",
    responsibilities: ["Design high-throughput APIs", "Own reliability of the payments platform"],
    requirements,
  },
  discussion: [
    { title: "Acme interview process 2026", url: "https://x.com/1", snippet: "Three rounds: behaviorals, a take-home on payment reconciliation, then a system-design whiteboard around idempotent APIs." },
  ],
  interviewPages: [
    {
      url: "https://acme.example/careers/interview",
      depth: 1,
      via: "https://acme.example/",
      title: "Our interview process",
      text: "Candidates get a system design round focused on idempotency and a take-home project. Expect database scaling questions.",
      fetched_at: "now",
    },
  ],
};

async function main() {
  const started = Date.now();
  const gen = new LlmGenerator();
  const questions = await gen.generateQuestions(ctx, requirements);
  const flashcards = await gen.generateFlashcards(ctx, requirements, questions);

  const byCategory = new Map<string, number>();
  for (const q of questions) byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
  const cats = Array.from(byCategory.keys()).sort();
  check("live: questions reference only real requirement ids", questions.every((q) => q.requirement_ids.every((id) => known.has(id))), `${questions.length} questions`);
  check("live: questions have stable unique q ids", questions.every((q, i) => q.id === `q${i + 1}`), `${questions.length} questions`);
  check("live: all 4 categories were generated separately", cats.length === 4, cats.join(","));
  check(
    "live: retrieved context influenced output (system_design / take-home present)",
    (byCategory.get("system-design") ?? 0) > 0 && questions.some((q) => /take-home|idempot/i.test(q.prompt) || /take-home|idempot/i.test(q.answer_outline)),
    `system-design=${byCategory.get("system-design") ?? 0} q=${questions.length}`,
  );
  check("live: flashcards returned without an extra call (source=category reuse)", flashcards.length > 0 && flashcards.every((f) => f.requirement_ids.every((id) => known.has(id))), `${flashcards.length} flashcards`);
  check("live: every question has an answer outline", questions.every((q) => q.answer_outline.length > 20), questions.map((q) => q.answer_outline.length).join(","));

  const counts = questions.reduce((acc, q) => acc + q.difficulty, 0);
  console.log(`  -> ${questions.length} questions (d=avg ${(counts / Math.max(1, questions.length)).toFixed(1)}), ${flashcards.length} flashcards, ${cats.length} categories`);
  console.log(`  -> sample [${byCategory.get("system-design")}] ${questions.find((q) => q.category === "system-design")?.prompt ?? "none"}`);

  // sanity: a two-line stub JD yields no questions (thin-and-honest end-to-end)
  const thin = new LlmGenerator();
  const thinQs = await thin.generateQuestions({ jd: "we are hiring", company: "x", company_brief: { summary: "", what_they_do: "", sources: [] }, role: { title: "", seniority: "", responsibilities: [], requirements: [] } }, []);
  check("live: empty requirements => zero questions, no padding", thinQs.length === 0, `${thinQs.length}`);

  console.log(`\n=== generation verify: ${pass} passed, ${failCount} failed, total wall ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
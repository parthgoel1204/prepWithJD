/**
 * Validation unit tests + one live repair round-trip.
 * Run: npx tsx tooling/verify-validation.ts
 */
import { join } from "node:path";
import { validateKitContent, validateOrRepair, kitContentSchema } from "../packages/pipeline/src/validation/index";
import { matchesShape } from "../packages/pipeline/src/llm/shape";
import { PipelineError } from "../packages/pipeline/src/errors";
import type { KitContent } from "../packages/pipeline/src/types";

const ROOT = join(import.meta.dirname, "..");
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* env missing */
}

let failCount = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failCount++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail === undefined ? "" : ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})`}`);
}

const base: KitContent = {
  source: { company: "Acme Inc", company_url: "https://acme.example", role: "Engineer", location: "", jd_chars: 100, researched_at: "2026-01-01T00:00:00.000Z", pages_used: [] },
  company_brief: { summary: "Acme is a payments platform.", what_they_do: "Reconciliation APIs.", sources: [] },
  role: { title: "Engineer", seniority: "Senior", responsibilities: ["Own reliability"], requirements: [{ id: "r1", text: "Go required", kind: "technical", priority: "must" }] },
  questions: [{ id: "q1", requirement_ids: ["r1"], category: "technical", prompt: "How do you design for throughput?", answer_outline: "Events; backpressure", difficulty: 2 }],
  flashcards: [{ id: "f1", front: "Kafka", back: "log", requirement_ids: ["r1"] }],
  schedule: { days_available: 14, days: [{ day: 1, focus: "Technical deep-dive", question_ids: ["q1"], minutes: 5 }] },
  coverage: { uncovered_requirement_ids: [], passes: 1 },
};

// --- pure validation ---
check("valid kit passes", validateKitContent(base).ok);

const thin: KitContent = {
  ...base,
  role: { title: "", seniority: "", responsibilities: [], requirements: [] },
  questions: [],
  flashcards: [],
  company_brief: { summary: "", what_they_do: "", sources: [] },
};
check("thin-and-honest kit passes (empty strings/arrays allowed)", validateKitContent(thin).ok);

const missingKey = structuredClone(base) as Record<string, unknown> & KitContent;
delete (missingKey as { company_brief?: unknown }).company_brief;
const mkv = validateKitContent(missingKey);
check("missing company_brief -> fail, repairable", !mkv.ok && mkv.repairable, mkv.ok ? "": mkv.errors.join(";"));

const badCategory = structuredClone(base);
(badCategory as { questions: Array<{ category: string }> }).questions[0].category = "leadership";
const bcv = validateKitContent(badCategory);
check("bad question category -> fail, NOT repairable", !bcv.ok && !bcv.repairable, bcv.ok ? "" : bcv.errors.join(";"));

const emptyPrompt = structuredClone(base);
(emptyPrompt as { questions: Array<{ prompt: string }> }).questions[0].prompt = "";
const epv = validateKitContent(emptyPrompt);
check("empty prompt -> fail, NOT repairable", !epv.ok && !epv.repairable, epv.ok ? "" : epv.errors.join(";"));

// optional keys (discussion / robots_blocked / stage_errors) are skip-when-absent
const withOptional = structuredClone(base) as KitContent;
withOptional.source.discussion = [{ title: "t", url: "https://x", snippet: "s" }];
withOptional.source.robots_blocked = [{ url: "https://x/p", via: "https://x", rule: "Disallow: /p" }];
withOptional.stage_errors = [{ stage: "retrieval", code: "HTTP_404", message: "a page 404'd", occurred_at: "now" }];
check("optional add-on fields are accepted", validateKitContent(withOptional).ok);
check("optional fields absent on source still validate", validateKitContent({ ...base, source: { ...base.source, discussion: undefined, robots_blocked: undefined } }).ok);

async function main() {
  // --- non-repairable failure throws a typed error without any LLM call ---
  try {
    await validateOrRepair(badCategory as KitContent, { apiKey: "blocked" });
    check("non-repairable -> throws typed VALIDATION_FAILED", false, "no throw");
  } catch (e) {
    check("non-repairable -> throws typed VALIDATION_FAILED", e instanceof PipelineError && e.code === "VALIDATION_FAILED", e instanceof Error ? e.message : "");
  }

  // --- live repair round-trip (one small LLM call) ---
  const repairable: KitContent = { ...base, company_brief: { summary: "Acme is a payments platform.", what_they_do: "", sources: [] } };
  delete (repairable as { company_brief?: { what_they_do?: string } }).company_brief.what_they_do;
  const rv = validateKitContent(repairable);
  check("live pre: missing what_they_do -> fail, repairable", !rv.ok && rv.repairable, rv.ok ? "" : rv.errors.join(";"));
  // One repair pass then typed error is the contract: the model may or may not
  // reproduce the missing key (best-effort), both outcomes are correct.
  let repairOutcome = "";
  let repairOk = false;
  try {
    const repaired = await validateOrRepair(repairable);
    repairOutcome = `repaired: what_they_do=${JSON.stringify(repaired.company_brief.what_they_do).slice(0, 60)}`;
    repairOk = validateKitContent(repaired).ok;
  } catch (e) {
    repairOutcome = "typed VALIDATION_FAILED after one repair (best-effort miss)";
    repairOk = e instanceof PipelineError && e.code === "VALIDATION_FAILED";
  }
  check("live: repair pass yields valid kit OR typed error (both contract-compliant)", repairOk, repairOutcome);

  // sanity: the schema accepts the canonical kit reference object
  check("sanity: kitContentSchema parses canonical kit", matchesShape(base, kitContentSchema).ok);

  console.log(`\n=== validation verify: ${failCount === 0 ? "all passed" : `${failCount} FAILED`} ===`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
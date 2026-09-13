import { join } from "node:path";
import { LlmExtractor } from "../packages/pipeline/src/extraction";

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

const NORMAL_JD = [
  "Senior Backend Engineer — Acme Inc",
  "Role",
  "Design and build high-throughput APIs and services in Go. Own reliability of the payments platform. Collaborating with product and mobile engineers.",
  "Requirements",
  "- 5+ years of backend engineering experience. Go required.",
  "- Strong SQL and data modelling (Postgres).",
  "- Experience with event-driven architecture and Kafka.",
  "- BONUS: Kubernetes and AWS.",
  "- Preferred: experience with fintech or payments.",
  "- Nice to have: contribute to open source.",
  "- You are an effective written communicator.",
].join("\n");

const TWO_LINE_STUB = "We are hiring!\nApply at https://work.example.com/careers";

const NICE_ONLY_JD = [
  "Staff Data Scientist — Example Corp",
  "Please bring experience with the following (all preferred, none strictly required):",
  "- Bonus: 3+ years using Python for production ML.",
  "- Plus if you know dbt.",
  "- Nice to have: a track record with A/B testing.",
  "- Preferred: familiarity with Snowflake.",
].join("\n");

async function main() {
  const started = Date.now();
  const extractor = new LlmExtractor();

  // CASE 1 — normal JD
  const normal = await extractor.extractRequirements({ jd: NORMAL_JD, company: "Acme Inc", pages: [] });
  const ids = normal.requirements.map((r) => r.id);
  check("normal JD: >=3 requirements extracted", normal.requirements.length >= 3, `${normal.requirements.length} requirements`);
  check("normal JD: ids are stable r1..rN contiguous", ids.every((id, i) => id === `r${i + 1}`) && new Set(ids).size === ids.length, ids.join(","));
  check("normal JD: all kind values valid", normal.requirements.every((r) => ["technical", "behavioural", "domain"].includes(r.kind)));
  check("normal JD: must/nice split present", normal.requirements.some((r) => r.priority === "must") && normal.requirements.some((r) => r.priority === "nice"), `must=${normal.requirements.filter((r) => r.priority === "must").length} nice=${normal.requirements.filter((r) => r.priority === "nice").length}`);
  const goReq = normal.requirements.find((r) => /Go\b/i.test(r.text));
  check("normal JD: 'Go required' came through as a must", !!goReq?.text.includes("Go"), goReq?.text ?? "not found");
  const invented = normal.requirements.find((r) => /git/i.test(r.text));
  check("normal JD: no industry-invented 'Git' requirement", !invented, invented?.text ?? "good");

  // CASE 2 — two-line stub: honest, thin, NOT padded
  const stub = await extractor.extractRequirements({ jd: TWO_LINE_STUB, company: "Example Corp", pages: [] });
  check("stub JD: zero (or near-zero) requirements, no invented padding", stub.requirements.length <= 1, `${stub.requirements.length} requirements`);
  check("stub JD: no fabricated 'must' requirements", stub.requirements.every((r) => r.priority === "nice"), stub.requirements.map((r) => `${r.id}:${r.priority}`).join(","));

  // CASE 3 — nice-only language, no must at all
  const niceOnly = await extractor.extractRequirements({ jd: NICE_ONLY_JD, company: "Example Corp", pages: [] });
  check("nice-only JD: >=1 requirement", niceOnly.requirements.length >= 1, `${niceOnly.requirements.length} requirements`);
  const priorities = niceOnly.requirements.map((r) => r.priority);
  check("nice-only JD: every priority is 'nice' despite the word 'years'", priorities.every((p) => p === "nice"), priorities.join(","));

  // Pure heuristic: coverageGaps flags a thin JD (no LLM)
  const gaps = await extractor.coverageGaps({ jd: TWO_LINE_STUB, company: "Example Corp", pages: [] });
  check("coverageGaps flags the two-line stub as thin", gaps.length >= 1, JSON.stringify(gaps));
  const gapsOk = await extractor.coverageGaps({ jd: NORMAL_JD, company: "Acme Inc", pages: [{ url: "https://acme.example", depth: 0, via: "", title: "t", text: "x", fetched_at: "now" }] });
  check("coverageGaps quiet for a healthy JD", gapsOk.length === 0, JSON.stringify(gapsOk));

  console.log(`\n=== extraction verify: ${pass} passed, ${failCount} failed, total wall ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
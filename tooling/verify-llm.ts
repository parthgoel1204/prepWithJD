import { join } from "node:path";
import { callLLM } from "../packages/pipeline/src/llm/client";
import { matchesShape } from "../packages/pipeline/src/llm/shape";

const ROOT = join(import.meta.dirname, "..");
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* env missing — LLM client reads process.env */
}

let pass = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass++;
  else failCount++;
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string" },
    years: { type: "integer", minimum: 0, maximum: 30 },
    must_have: { type: "boolean" },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["role", "years", "must_have", "keywords"],
} as const;

// --- shape validator unit cases (pure, no LLM) ---
check("shape: valid object", matchesShape({ role: "eng", years: 3, must_have: true, keywords: [] }, schema).ok);
check("shape: rejects missing required", !matchesShape({ role: "eng", years: 3 }, schema).ok);
check("shape: rejects extra property", !matchesShape({ role: "eng", years: 3, must_have: true, keywords: [], nope: 1 }, schema).ok);
check("shape: rejects wrong type", !matchesShape({ role: 5, years: 3, must_have: true, keywords: [] }, schema).ok);
check("shape: rejects out-of-range integer", !matchesShape({ role: "eng", years: 99, must_have: true, keywords: [] }, schema).ok);

// --- live Groq strict-mode round trip (watchdog metrics) ---
async function main() {
  const started = Date.now();
  try {
  const res = await callLLM(
    'Given the job ad "Senior Frontend Engineer. 5+ years of React required. Bonus: GraphQL.", return the role info.',
    { system: "You are a hiring-bot JSON extractor.", schema, schemaName: "role_info" },
  );
  const m = res.metrics;
  check(
    "live: strict JSON parsed + shape-valid",
    matchesShape(res.json, schema).ok,
    `role=${(res.json as any).role} years=${(res.json as any).years}`,
  );
  check(
    "live: usage reported",
    m.totalTokens > 0,
    `prompt=${m.promptTokens} completion=${m.completionTokens} reasoning=${m.reasoningTokens} total=${m.totalTokens} cached=${m.cachedTokens ?? 0}`,
  );
  console.log(`  metrics: attempts=${m.attempts} repair=${m.repairUsed} lasted=${m.durationMs}ms (${res.metrics.model})`);
  console.log(`  sample JSON: ${JSON.stringify(res.json)}`);
} catch (e) {
  check("live: strict JSON parsed + shape-valid", false, `ERROR ${(e as Error).message}`);
}

// --- live: no schema → plain text JSON (repair path not triggered) ---
try {
  const res = await callLLM('Reply with only this JSON: {"ok": true}', { maxTokens: 40, temperature: 0 });
  check("live: plain JSON mode works", (res.json as any)?.ok === true, `total=${res.metrics.totalTokens}`);
} catch (e) {
  check("live: plain JSON mode works", false, `ERROR ${(e as Error).message}`);
}

console.log(`\n=== llm client verify: ${pass} passed, ${failCount} failed, total wall ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
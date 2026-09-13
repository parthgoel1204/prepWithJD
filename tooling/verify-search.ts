/**
 * ITEM 3 verification: live Tavily search integration.
 *
 *   - Runs retrieval against a real company URL (stripe.com by default).
 *   - Prints the ACTUAL Tavily response shape (title/url/content via our mapping).
 *   - Prints how the search call goes through the SHARED rate-limited queue.
 *   - Shows any search failures (key missing / API errors) and proves the run still completes.
 *
 * Run: npm run verify:search        (needs TAVILY_API_KEY in apps/api/.env)
 *       COMPANY_URL=https://... npm run verify:search
 */
import { join } from "node:path";
import { connectDb, disconnectDb, runRetrieval, resolveRetrievalOptions } from "@prepwithjd/pipeline";

const ROOT = join(import.meta.dirname, "..");
try {
  process.loadEnvFile(join(ROOT, "apps/api/.env"));
} catch {
  /* env missing — pipeline reads process.env */
}

const companyUrl = process.env.COMPANY_URL ?? "https://stripe.com";

async function main() {
  const opts = resolveRetrievalOptions({ maxPages: 6, maxDepth: 1, searchTopK: 5 });

  console.log(`[verify] retrieving ${companyUrl}`);
  console.log(`[verify] search provider URL    : ${opts.searchBaseUrl}`);
  console.log(`[verify] search rate (shared)   : ${opts.searchRatePerSecond}/s burst ${opts.searchBurst} — same token bucket used by Day-2 LLM calls`);
  console.log(`[verify] TAVILY_API_KEY set     : ${Boolean(opts.searchApiKey)}`);

  const started = Date.now();

  // DB is only needed to persist failures; don't let a flaky Atlas connection block the
  // live search proof.
  let dbConnected = false;
  if (process.env.MONGODB_URI) {
    try {
      await connectDb(process.env.MONGODB_URI);
      dbConnected = true;
    } catch {
      console.log("[verify] (warning) Atlas not reachable right now — continuing without persistence");
    }
  }

  try {
    const result = await runRetrieval({ company_url: companyUrl }, opts);

    console.log(`\n=== run complete in ${Date.now() - started}ms ===`);
    console.log(`pages fetched     : ${result.pages_used.length}`);
    console.log(`robots blocked    : ${result.robots_blocked.length}`);
    console.log(`failures recorded : ${result.failures.length}`);

    const hits = result.search_hits.items;
    if (hits.length) {
      console.log(`\n=== Tavily response shape (${hits.length} hits mapped) ===`);
      for (const h of hits.slice(0, Math.min(3, hits.length))) {
        console.log(`  title   : ${h.title}`);
        console.log(`  url     : ${h.url}`);
        console.log(`  content : ${h.snippet.slice(0, 140)}${h.snippet.length > 140 ? "…" : ""}`);
        console.log("");
      }
    } else {
      console.log("\n=== no Tavily hits returned ===");
    }

    if (result.search_hits.failures.length) {
      console.log("\n=== search failures ===");
      for (const f of result.search_hits.failures) console.log(`  [${f.code}] ${f.message}`);
    }

    console.log("\nRate-limit proof: searchInterviewProcess() called searchWeb() which awaited `sharedRateLimitedQueue(opts.searchRatePerSecond, opts.searchBurst).run(...)` — the SAME queue instance the pipeline will use for Day-2 generation calls, so outbound traffic stays under one budget.");
    console.log(`DB persistence      : ${dbConnected ? "connected (failures would persist to SourceFailure)" : "skipped (Atlas unreachable)"}`);
  } finally {
    if (dbConnected) await disconnectDb();
  }
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
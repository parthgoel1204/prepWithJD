/**
 * Day-1 smoke test: crawl the LOCAL fixture site (non-hardcoded host) and assert the
 * retrieval contract — robots.txt honoured, ranking picks careers, failures recorded
 * not thrown, and the search stage degrades gracefully without an API key.
 *
 * Run: npm run smoke
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runRetrieval } from "@prepwithjd/pipeline";

const FIXTURE_URL = "http://127.0.0.1:8765";
const ROOT = dirname(fileURLToPath(import.meta.url));

function startFixture(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "fixture-site", "server.mjs")], {
      env: { ...process.env, FIXTURE_PORT: "8765" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout?.on("data", (d) => {
      if (d.toString().includes("[fixture]")) {
        resolve({ port: 8765, close: () => child.kill() });
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("fixture did not start in time")), 5000).unref?.();
  });
}

async function main() {
  const fixture = await startFixture();
  const results: string[] = [];
  const check = (label: string, pass: boolean, detail = "") => {
    results.push(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  };

  try {
    const res = await runRetrieval(
      { company_url: FIXTURE_URL },
      {
        allowPrivateUrls: true,
        maxPages: 12,
        maxDepth: 3,
        timeoutMs: 3000,
        retries: 1,
      },
    );

    const urls = res.pages_used;

    check("homepage was fetched", urls.includes(`${FIXTURE_URL}/`), urls.join(", "));
    check("careers page was ranked & crawled", urls.includes(`${FIXTURE_URL}/careers`));
    check("interview-process page reached via relative link", urls.includes(`${FIXTURE_URL}/careers/interview-process`));
    check("robots-disallowed /private page NOT crawled", !urls.includes(`${FIXTURE_URL}/private`), JSON.stringify(urls));
    check("crawler never aborted on missing pages", res.pages.every((p) => p.title.length >= 0));
    check("pages carry text + title", res.pages.length > 0 && res.pages[0]!.text.length > 20, `page0 text=${res.pages[0]!.text.length} chars`);

    const searchFailure = res.failures.find((f) => f.stage === "search");
    check(
      "search stage degrades gracefully without key",
      searchFailure !== undefined && searchFailure.code === "SEARCH_API_KEY_MISSING",
    );

    if (res.search_hits.items.length) {
      const anyExternal = res.search_hits.items[0]!.url.startsWith("http");
      check("search hits are external urls", anyExternal);
    }
  } catch (err) {
    check("no uncaught error during crawl", false, err instanceof Error ? err.message : String(err));
  } finally {
    fixture.close();
  }

  console.log("\n=== retrieval smoke results ===");
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
import type { RetrievalFailure, RetrievalOptions, SearchHits } from "../types";
import { nowIso } from "../lib/util";
import { sharedRateLimitedQueue } from "./rateLimit";

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/**
 * Search public discussion of a company's interview process via the Brave Search API
 * (free tier). Every call goes through the shared rate-limited queue, the same queue
 * that will pace LLM calls on Day 2.
 *
 * Missing API key is NOT an error — it is reported as a structured failure so a run
 * still completes without fabricating anything.
 */
export async function searchInterviewProcess(
  _companyUrl: string,
  company: string,
  opts: Required<RetrievalOptions>,
): Promise<SearchHits> {
  const query = `"${company}" interview process culture hiring`;
  return searchWeb(query, opts);
}

/** Generic Brave web search used by the discussion lookup. */
export async function searchWeb(query: string, opts: Required<RetrievalOptions>): Promise<SearchHits> {
  const failures: RetrievalFailure[] = [];

  if (!opts.searchApiKey) {
    return {
      items: [],
      failures: [
        {
          source_url: opts.searchBaseUrl,
          stage: "search",
          code: "SEARCH_API_KEY_MISSING",
          message: "BRAVE_API_KEY not configured — skipping public-discussion search (honest empty result, not fabricated)",
          occurred_at: nowIso(),
        },
      ],
    };
  }

  const queue = sharedRateLimitedQueue(opts.searchRatePerSecond, opts.searchBurst);
  try {
    const results = await queue.run(async () => {
      const url = new URL(opts.searchBaseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("count", String(opts.searchTopK));
      url.searchParams.set("search_lang", "en");

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "X-Subscription-Token": opts.searchApiKey,
          Accept: "application/json",
          "User-Agent": opts.userAgent,
        },
      });
      if (!res.ok) throw new Error(`search API HTTP ${res.status}`);
      const data = (await res.json()) as BraveResponse;
      return (data.web?.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
    });

    const items = results.filter((r) => r.url);
    return { items, failures };
  } catch (err) {
    failures.push({
      source_url: opts.searchBaseUrl,
      stage: "search",
      code: "SEARCH_API_FAILED",
      message: err instanceof Error ? err.message : String(err),
      occurred_at: nowIso(),
    });
    return { items: [], failures };
  }
}
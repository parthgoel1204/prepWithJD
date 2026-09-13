import type { RetrievalFailure, RetrievalOptions, SearchHits } from "../types";
import { nowIso } from "../lib/util";
import { sharedRateLimitedQueue } from "./rateLimit";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  query?: string;
  results?: TavilyResult[];
  answer?: string | null;
}

/**
 * Search public discussion of a company's interview process via the Tavily API.
 * Every call goes through the SHARED rate-limited queue — the same token bucket that
 * will pace LLM calls on Day 2 — so outbound research traffic stays throttled.
 *
 * A missing/invalid key is NOT a fatal error: it is reported as a structured failure so
 * the run still completes without fabricating anything.
 */
export async function searchInterviewProcess(
  _companyUrl: string,
  company: string,
  opts: Required<RetrievalOptions>,
): Promise<SearchHits> {
  const query = `"${company}" interview process culture hiring`;
  return searchWeb(query, opts);
}

/** Generic search used by the discussion lookup (single provider: Tavily). */
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
          message: "TAVILY_API_KEY not configured — skipping public-discussion search (honest empty result, not fabricated)",
          occurred_at: nowIso(),
        },
      ],
    };
  }

  // Shared token bucket: search and (later) LLM calls all compete for the same budget.
  const queue = sharedRateLimitedQueue(opts.searchRatePerSecond, opts.searchBurst);

  try {
    const items = await queue.run(async () => {
      const res = await fetch(opts.searchBaseUrl, {
        method: "POST",
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": opts.userAgent,
        },
        body: JSON.stringify({
          api_key: opts.searchApiKey,
          query,
          search_depth: "basic",
          max_results: opts.searchTopK,
          include_answer: false,
          include_raw_content: false,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`search API HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`);
      }

      const data = (await res.json()) as TavilyResponse;
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      }));
    });

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
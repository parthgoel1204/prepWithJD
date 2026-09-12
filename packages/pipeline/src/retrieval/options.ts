import type { RetrievalOptions } from "../types";
import { clampInt } from "../lib/util";

export const DEFAULT_USER_AGENT = "prepWithJD-bot/0.1 (+local-dev)";

/** Defaults + env overrides for a retrieval run. All values overridable per-call. */
export function resolveRetrievalOptions(overrides?: RetrievalOptions, env: NodeJS.ProcessEnv = process.env): Required<RetrievalOptions> {
  const bool = (v: string | undefined, fb: boolean) => (v === undefined ? fb : v === "1" || v.toLowerCase() === "true");

  return {
    timeoutMs: clampInt(overrides?.timeoutMs ?? 10_000, 10_000, 500, 60_000),
    retries: clampInt(overrides?.retries ?? 3, 3, 0, 6),
    maxBytes: clampInt(overrides?.maxBytes ?? 3 * 1024 * 1024, 3 * 1024 * 1024, 16 * 1024, 20 * 1024 * 1024),
    maxPages: clampInt(overrides?.maxPages ?? 10, 10, 1, 50),
    maxDepth: clampInt(overrides?.maxDepth ?? 2, 2, 0, 5),
    maxCandidatesPerPage: clampInt(overrides?.maxCandidatesPerPage ?? 8, 8, 1, 30),
    maxTextLength: clampInt(overrides?.maxTextLength ?? 40_000, 40_000, 500, 500_000),
    allowPrivateUrls: overrides?.allowPrivateUrls ?? bool(env.ALLOW_PRIVATE_URLS, env.NODE_ENV !== "production"),
    userAgent: overrides?.userAgent ?? env.CRAWLER_USER_AGENT ?? DEFAULT_USER_AGENT,
    statusCap: clampInt(overrides?.statusCap ?? 200, 200, 0, 600),
    searchApiKey: overrides?.searchApiKey ?? env.BRAVE_API_KEY ?? "",
    searchBaseUrl: overrides?.searchBaseUrl ?? env.SEARCH_BASE_URL ?? "https://api.search.brave.com/res/v1/web/search",
    searchTopK: clampInt(overrides?.searchTopK ?? 8, 8, 1, 20),
    searchRatePerSecond: clampInt(overrides?.searchRatePerSecond ?? 2, 2, 0.1, 60),
    searchBurst: clampInt(overrides?.searchBurst ?? 8, 8, 1, 100),
  };
}
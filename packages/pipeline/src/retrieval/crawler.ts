import type { CrawledPage, RetrievalFailure, RetrievalOptions, RetrievalResult, SearchHits } from "../types";
import { nowIso, companyNameFromUrl } from "../lib/util";
import { checkUrl } from "./guard";
import { fetchPage, parseHtml } from "./fetcher";
import { extractInternalLinks, rankInternalLinks } from "./links";
import { loadRobots } from "./robots";
import { searchInterviewProcess } from "./search";

export interface CrawlDraft {
  company: string;
  pages: CrawledPage[];
  pages_used: string[];
  search_hits: SearchHits;
}

/** Crawl a site without assuming anything about its host/paths. */
export async function crawlSite(companyUrl: string, opts: Required<RetrievalOptions>): Promise<{ draft: CrawlDraft; failures: RetrievalFailure[] }> {
  const failures: RetrievalFailure[] = [];

  const verdict = checkUrl(companyUrl, { allowPrivateUrls: opts.allowPrivateUrls, isProduction: process.env.NODE_ENV === "production" });
  if (!verdict.ok || !verdict.url) {
    failures.push({
      source_url: companyUrl,
      stage: "validate",
      code: verdict.code ?? "URL_REJECTED",
      message: verdict.message ?? "URL rejected before crawling",
      occurred_at: nowIso(),
    });
    return {
      draft: { company: companyNameFromUrl(companyUrl), pages: [], pages_used: [], search_hits: { items: [], failures: [] } },
      failures,
    };
  }

  const origin = verdict.url.origin;
  const baseUrl = verdict.url.toString().split("#")[0]!;
  const company = companyNameFromUrl(origin) || companyNameFromUrl(companyUrl);
  const visited = new Map<string, number>(); // url -> depth
  const pageTitles = new Map<string, string>();
  const anchorContext = new Map<string, string>();
  const pages: CrawledPage[] = [];
  const queue: Array<{ url: string; depth: number; via: string }> = [{ url: baseUrl, depth: 0, via: "manual-input" }];

  const robots = await loadRobots(origin, opts);
  if (robots.failure) failures.push(robots.failure);
  const crawlGapMs = robots.rules?.crawlDelayMs ?? 0;
  let lastFetchAt = 0;

  async function waitForGap(): Promise<void> {
    if (!crawlGapMs) return;
    const now = Date.now();
    const gap = crawlGapMs - (now - lastFetchAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  }

  while (queue.length && pages.length < opts.maxPages) {
    const item = queue.shift()!;
    const depth = item.depth;
    if (depth > opts.maxDepth) continue;
    if (visited.has(item.url)) continue;
    if (!robots.rules?.isAllowed(item.url, opts.userAgent)) continue; // robots says no
    visited.set(item.url, depth);

    await waitForGap();
    const started = Date.now();
    const fetched = await fetchPage(item.url, opts);
    lastFetchAt = Date.now();

    if (!fetched.ok || !fetched.result) {
      if (fetched.failure) failures.push(fetched.failure);
      continue;
    }

    const parsed = parseHtml(fetched.result.html, opts.maxTextLength);
    pages.push({
      url: fetched.result.finalUrl,
      depth,
      via: item.via,
      title: parsed.title,
      text: parsed.text,
      fetched_at: new Date(started).toISOString(),
    });

    if (depth < opts.maxDepth) {
      const links = extractInternalLinks(parsed, baseUrl, fetched.result.finalUrl);
      for (const l of links) {
        if (!anchorContext.has(l)) anchorContext.set(l, "");
      }
      // Enrich link text from this page's anchors for ranking at parent level.
      for (const a of parsed.anchors) {
        try {
          const abs = new URL(a.href, fetched.result.finalUrl).toString().split("#")[0]!;
          if (abs.startsWith(origin) && !a.text.toLowerCase().startsWith("window.location")) anchorContext.set(abs, a.text);
        } catch {
          /* ignore unparseable */
        }
      }
      for (const l of links) {
        if (!pageTitles.has(l)) pageTitles.set(l, parsed.title);
      }

      const candidates = rankInternalLinks(links, anchorContext, pageTitles, opts.maxCandidatesPerPage);
      for (const c of candidates) {
        if (!visited.has(c.url) && !queue.some((q) => q.url === c.url)) {
          queue.push({ url: c.url, depth: depth + 1, via: item.url });
        }
      }
    }
  }

  const search_hits = await searchInterviewProcess(companiesToSearch(companyUrl), company, opts);
  failures.push(...search_hits.failures);

  return {
    draft: {
      company,
      pages,
      pages_used: pages.map((p) => p.url),
      search_hits,
    },
    failures,
  };
}

function companiesToSearch(companyUrl: string): string {
  return companyUrl;
}
import type { ParsedPage } from "./fetcher";

/** Extensions that can never be a crawlable text page — skip at discovery so we don't fetch svg/png/pdf/… links and log noise. */
const ASSET_EXTENSION = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|wav|pdf|docx?|xlsx?|pptx?|zip|gz|tar|rar|7z|css|js|json)$/i;

/** Resolve anchors to absolute same-origin URLs. Host-agnostic — works for any site. */
export function extractInternalLinks(page: ParsedPage, baseUrl: string, sourceHtmlBase: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Use the final fetched URL as the resolution base whenever we have it.
  let base: URL;
  try {
    base = new URL(sourceHtmlBase || baseUrl);
  } catch {
    return [];
  }

  for (const a of page.anchors) {
    const href = a.href.trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    let target: URL;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") continue;
    if (target.origin !== base.origin) continue; // internal only
    if (ASSET_EXTENSION.test(target.pathname)) continue; // image/font/doc/asset, not a page
    target.hash = "";
    const url = target.toString();
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Score internal links by keyword affinity in the LINK TEXT (strongest signal) then in
 * the URL path/host. No prescriptive path list — it generalizes by vocabulary.
 * Links with zero affinity are kept as low-priority fallbacks so unknown sites still
 * get crawled.
 */

const HIGH_KEYWORDS = /careers|jobs|job|hiring|join|openings|vacanc|recruit|talent/i;
const MEDIUM_KEYWORDS = /culture|handbook|engineering|blog|about|team|life|values|interview|why-us/i;

export interface RankableLink {
  url: string;
  text: string;
  score: number;
}

export function scoreLink(url: string, text: string): number {
  let score = 0;
  if (HIGH_KEYWORDS.test(text)) score += 6;
  if (HIGH_KEYWORDS.test(url)) score += 3;
  if (MEDIUM_KEYWORDS.test(text)) score += 3;
  if (MEDIUM_KEYWORDS.test(url)) score += 2;
  return score;
}

export function rankInternalLinks(
  extracted: string[],
  anchorContext: Map<string, string>,
  pageTitles: Map<string, string>,
  limit: number,
): RankableLink[] {
  const scored: RankableLink[] = extracted.map((url) => {
    const text = anchorContext.get(url) ?? "";
    const title = pageTitles.get(url) ?? "";
    return { url, text: text || title, score: scoreLink(url, `${text} ${title}`) };
  });

  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored.slice(0, limit);
}
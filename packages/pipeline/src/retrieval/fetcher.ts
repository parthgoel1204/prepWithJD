import * as cheerio from "cheerio";
import type { RetrievalFailure, RetrievalOptions, RetrievalStage } from "../types";
import { nowIso } from "../lib/util";
import { checkUrl } from "./guard";

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string | null;
  headers: Headers;
  /** Raw HTML body (bytes) */
  html: string;
  ok: boolean;
}

export interface ParsedPage {
  title: string;
  text: string;
  anchors: Array<{ href: string; text: string }>;
}

export interface FetchOutcome {
  ok: boolean;
  result?: FetchResult;
  failure?: RetrievalFailure;
}

const ACCEPTED_PAGE_TYPES = ["text/html", "application/xhtml+xml"];
const ACCEPTED_PLAIN_TYPES = ["text/plain", "text/html"];

function makeFailure(sourceUrl: string, stage: RetrievalStage, code: string, message: string, attempt?: number): RetrievalFailure {
  return { source_url: sourceUrl, stage, code, message, attempt, occurred_at: nowIso() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch a URL with timeout + retry-with-exponential-backoff.
 * Never throws for fetch-level problems — returns ok:false + a structured failure so
 * callers can log-and-continue.
 */
export async function fetchPage(
  rawUrl: string,
  opts: Required<RetrievalOptions>,
  stage: RetrievalStage = "fetch",
): Promise<FetchOutcome> {
  const checked = checkUrl(rawUrl, { allowPrivateUrls: opts.allowPrivateUrls, isProduction: process.env.NODE_ENV === "production" });
  if (!checked.ok || !checked.url) {
    return { ok: false, failure: makeFailure(rawUrl, "validate", checked.code ?? "URL_REJECTED", checked.message ?? "url rejected") };
  }

  const accepted = stage === "robots" ? ACCEPTED_PLAIN_TYPES : ACCEPTED_PAGE_TYPES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs);

  let lastFailure = makeFailure(rawUrl, "fetch", "UNKNOWN", "fetch failed");
  try {
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250;
        await sleep(backoff);
      }
      try {
        const res = await fetch(rawUrl, {
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": opts.userAgent, Accept: accepted.join(", ") },
        });

        const contentType = res.headers.get("content-type") ?? "";

        if (!res.ok && res.status !== 404) {
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < opts.retries) {
            const ra = res.headers.get("retry-after");
            const wait = ra ? Number(ra) * 1000 : undefined;
            lastFailure = makeFailure(rawUrl, "fetch", `HTTP_${res.status}`, `HTTP ${res.status} (will retry)`, attempt);
            if (wait && Number.isFinite(wait)) await sleep(Math.min(wait, 8000));
            continue;
          }
          if (retryable) {
            return { ok: false, failure: makeFailure(rawUrl, "fetch", `HTTP_${res.status}`, `HTTP ${res.status} after ${opts.retries} retries`, attempt) };
          }
        }

        // HTTP status wins over body sniffing: a 404 even with a weird content-type
        // is a not-found, not a type-rejection.
        if (res.status === 404) return { ok: false, failure: makeFailure(rawUrl, "fetch", "HTTP_404", "Not found", attempt) };

        const baseType = contentType.split(";")[0]!.trim().toLowerCase();
        if (!accepted.includes(baseType)) {
          return { ok: false, failure: makeFailure(rawUrl, "fetch", "CONTENT_TYPE_REJECTED", `Unsupported content-type "${baseType}"`, attempt) };
        }

        const sizeHeader = res.headers.get("content-length");
        if (sizeHeader && Number(sizeHeader) > opts.maxBytes) {
          return { ok: false, failure: makeFailure(rawUrl, "fetch", "CONTENT_TOO_LARGE", `Response exceeds ${opts.maxBytes} bytes`, attempt) };
        }

        // Re-validate the final URL after redirects (defence against redirect-to-private).
        const progressed = checkUrl(res.url, { allowPrivateUrls: opts.allowPrivateUrls, isProduction: process.env.NODE_ENV === "production" });
        if (!progressed.ok) {
          return { ok: false, failure: makeFailure(rawUrl, "validate", "REDIRECT_REJECTED", `Redirect target rejected: ${progressed.message}`, attempt) };
        }

        const finalUrl = res.url || rawUrl;

        let total = 0;
        const chunks: Uint8Array[] = [];
        if (!res.body) return { ok: false, failure: makeFailure(finalUrl, "fetch", "EMPTY_BODY", "Response has no body", attempt) };
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > opts.maxBytes) {
            controller.abort(new Error("size cap exceeded"));
            return { ok: false, failure: makeFailure(finalUrl, "fetch", "CONTENT_TOO_LARGE", `Body exceeded ${opts.maxBytes} bytes`, attempt) };
          }
          chunks.push(chunk);
        }

        const html = Buffer.concat(chunks).toString("utf8");
        return {
          ok: true,
          result: { finalUrl, status: res.status, contentType: baseType || null, headers: res.headers, html, ok: res.ok },
        };
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || /timeout/i.test(err.message ?? ""));
        const code = timedOut ? "TIMEOUT" : err instanceof TypeError ? "NETWORK_ERROR" : "FETCH_FAILED";
        lastFailure = makeFailure(rawUrl, "fetch", code, err instanceof Error ? err.message : String(err), attempt);
        if (attempt < opts.retries) continue;
      }
    }
    return { ok: false, failure: lastFailure };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract plain text + internal anchors from a page's HTML.
 * Designed to be host-agnostic: works on any HTML, relative hrefs resolved by the caller.
 */
export function parseHtml(html: string, maxTextLength: number): ParsedPage {
  const $ = cheerio.load(html);

  const title = ($("title").first().text() || "").trim();

  const anchors: Array<{ href: string; text: string }> = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (href) anchors.push({ href, text });
  });

  const body = $("body").clone();
  body.find("script, style, noscript, svg, template, iframe, form").remove();
  const text = body.text().replace(/\s+/g, " ").trim();

  return {
    title,
    text: text.length > maxTextLength ? text.slice(0, maxTextLength) : text,
    anchors,
  };
}
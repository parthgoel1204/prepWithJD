/** Best-effort company name from a URL hostname: strips www and common subdomains. */
export function companyNameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host
      .replace(/^www\./, "")
      .replace(/^(careers|jobs|join|hiring|about|engineering)\./, "")
      .split(".")
      .slice(0, -1)
      .join(" ")
      .trim() || host;
  } catch {
    return "";
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Exponential backoff delay between retry attempts (ms), with random jitter.
 * THE single copy of this logic: fetchPage (HTTP retries) and callLLM (Groq
 * 429/5xx retries) both reuse it — do not inline your own.
 */
export function exponentialBackoffMs(attempt: number, baseMs = 1000, capMs = 8000, jitterMs = 250): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs) + Math.random() * jitterMs;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}
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

export function nowIso(): string {
  return new Date().toISOString();
}
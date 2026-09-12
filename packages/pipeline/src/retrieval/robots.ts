import type { RetrievalFailure, RetrievalOptions } from "../types";
import { nowIso } from "../lib/util";
import { fetchPage } from "./fetcher";

interface RobotsGroup {
  agent: string;
  allow: string[];
  disallow: string[];
  crawlDelaySeconds: number | null;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}`);
}

function pathLength(pattern: string): number {
  return pattern.length;
}

export class RobotsRules {
  private readonly groups: RobotsGroup[];
  readonly crawlDelayMs: number | null;

  constructor(groups: RobotsGroup[]) {
    this.groups = groups;
    const delays = groups.map((g) => g.crawlDelaySeconds).filter((d): d is number => d !== null && d > 0);
    this.crawlDelayMs = delays.length ? Math.max(...delays) * 1000 : null;
  }

  private groupFor(userAgent: string): RobotsGroup | null {
    const exact = this.groups.find((g) => g.agent !== "*" && userAgent.toLowerCase().includes(g.agent.toLowerCase()));
    if (exact) return exact;
    return this.groups.find((g) => g.agent === "*") ?? null;
  }

  /** Robots "longest matching rule wins, Allow breaks ties" logic. */
  isAllowed(rawUrl: string, userAgent: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    const group = this.groupFor(userAgent);
    if (!group) return true;

    const path = url.pathname + url.search;
    let bestRule: { allow: boolean; len: number } | null = null;
    for (const pattern of group.allow) {
      if (patternToRegex(pattern).test(path)) {
        const len = pathLength(pattern);
        if (!bestRule || len > bestRule.len) bestRule = { allow: true, len };
      }
    }
    for (const pattern of group.disallow) {
      if (patternToRegex(pattern).test(path)) {
        const len = pathLength(pattern);
        if (!bestRule || len > bestRule.len) bestRule = { allow: false, len };
      }
    }
    return bestRule ? bestRule.allow : true;
  }
}

export interface RobotsOutcome {
  rules: RobotsRules | null;
  failure?: RetrievalFailure;
  /** disallow everything if the origin refuses robots parsing ambiguously */
  allow: boolean;
}

const UA_GROUPS: Record<string, "agent" | "disallow" | "allow" | "crawlDelay"> = {
  "user-agent": "agent",
  disallow: "disallow",
  allow: "allow",
  "crawl-delay": "crawlDelay",
};

/**
 * Fetch + parse robots.txt for an origin. Never throws: a missing/unreadable robots.txt
 * returns an allow-all outcome plus an optional failure record so the caller can log it.
 */
export async function loadRobots(origin: string, opts: Required<RetrievalOptions>): Promise<RobotsOutcome> {
  const robotsUrl = new URL(origin);
  if (!["http:", "https:"].includes(robotsUrl.protocol)) return { rules: null, allow: true };
  robotsUrl.pathname = "/robots.txt";
  robotsUrl.search = "";
  robotsUrl.hash = "";

  const fetched = await fetchPage(robotsUrl.toString(), opts, "robots");
  if (!fetched.ok || !fetched.result) {
    return {
      rules: null,
      allow: true,
      failure: fetched.failure ?? {
        source_url: robotsUrl.toString(),
        stage: "robots",
        code: "ROBOTS_FETCH_FAILED",
        message: "Could not read robots.txt — continuing with allow-all",
        occurred_at: nowIso(),
      },
    };
  }

  const groups = parseRobotsTxt(fetched.result.html);
  return { rules: new RobotsRules(groups), allow: true };
}

/** Parse robots.txt into disjoint UA groups (this group's rules apply). */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line || !line.includes(":")) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key) continue;

    const kind = UA_GROUPS[key.toLowerCase()];
    if (!kind) continue;

    if (kind === "agent") {
      if (!current || current.agent !== value) {
        current = { agent: value.toLowerCase(), allow: [], disallow: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      continue;
    }
    if (!current) continue;

    if (kind === "disallow") {
      if (value !== "") current.disallow.push(value);
      continue;
    }
    if (kind === "allow") {
      current.allow.push(value);
      continue;
    }
    if (kind === "crawlDelay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySeconds = n;
    }
  }

  return groups;
}
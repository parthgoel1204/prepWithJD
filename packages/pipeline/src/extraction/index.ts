/**
 * Requirement extraction (Day 2, real implementation).
 *
 * LlmExtractor grounds EVERY extracted requirement in the JD text. The prompt
 * forbids implied/industry-standard requirements ("must know Git" just because
 * the role is a backend role) and explicitly blesses EMPTY results for thin JDs —
 * a two-line stub yields a thin, honest kit, never invented padding.
 *
 * priority postprocessing: the model is anchored to a strict rule (must only for
 * mandatory language; nice for bonus/plus/preferred), and a best-effort
 * consistency check logs warnings for any priority that reads contradictory.
 */
import type { CompanyBrief, CrawledPage, Requirement } from "../types";
import { PipelineError, PipelineNotImplementedError } from "../errors";
import { callLLM, type LLMCallResult } from "../llm/client";
import { matchesShape, type JsonSchema } from "../llm/shape";

export interface ExtractionContext {
  jd: string;
  company: string;
  pages: CrawledPage[];
}

/** Pure extraction: researched pages + JD -> structured brief / requirement obligations. */
export interface Extractor {
  extractCompanyBrief(ctx: ExtractionContext): Promise<CompanyBrief>;
  /** Extract ONLY claims grounded in the JD text — never invented requirements. */
  extractRequirements(
    ctx: ExtractionContext,
  ): Promise<{ title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] }>;
  /** If the JD is thin, report which sections are thin/absent so the UI can say so. */
  coverageGaps(ctx: ExtractionContext): Promise<string[]>;
}

export class NotImplementedExtractor implements Extractor {
  async extractCompanyBrief(_ctx: ExtractionContext): Promise<CompanyBrief> {
    throw new PipelineNotImplementedError("extraction");
  }
  async extractRequirements(
    _ctx: ExtractionContext,
  ): Promise<{ title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] }> {
    throw new PipelineNotImplementedError("extraction");
  }
  async coverageGaps(_ctx: ExtractionContext): Promise<string[]> {
    throw new PipelineNotImplementedError("extraction");
  }
}

// ---------- schemas (hand-written: minimal, Groq-strict-compatible) ----------

const requirementItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "placeholder id, re-assigned deterministically as r1, r2, ..." },
    text: { type: "string", maximumLength: 400, description: "one explicit requirement, verbatim-close to the JD wording" },
    kind: { type: "string", enum: ["technical", "behavioural", "domain"] },
    priority: { type: "string", enum: ["must", "nice"] },
  },
  required: ["id", "text", "kind", "priority"],
};

const requirementsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", maximumLength: 200 },
    seniority: { type: "string", maximumLength: 120 },
    responsibilities: { type: "array", items: { type: "string", maximumLength: 300 }, description: "job responsibilities explicitly listed in the JD" },
    requirements: { type: "array", items: requirementItemSchema },
  },
  required: ["title", "seniority", "responsibilities", "requirements"],
};

const companyBriefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", maximumLength: 600 },
    what_they_do: { type: "string", maximumLength: 800 },
    sources: { type: "array", items: { type: "string" }, description: "subset of the provided researched URLs used" },
  },
  required: ["summary", "what_they_do", "sources"],
};

const REQUIREMENTS_SYSTEM =
  "You extract hiring requirements from a raw job description. " +
  "Rules: 1) Extract ONLY requirements explicitly present in the JD text — never add implied, industry-standard, or typical-for-the-role skills. " +
  "If the JD says '5+ years with React', React years are a requirement; Git is NOT to be added just because it is common for the role. " +
  "2) Do not pad: if the JD has very few or zero explicit requirements, return zero. An empty list is a valid, expected outcome. " +
  "3) priority rule (anchor to these words only): 'must' ONLY when the JD uses mandatory language such as 'required', 'must have', 'essential', 'mandatory', or an explicit number of years ('5+ years'). " +
  "'nice' when the JD uses 'bonus', 'plus', 'preferred', 'nice to have', 'desired', 'good to have'. " +
  "When the language is genuinely ambiguous, default to 'nice' — never guess 'must' without mandatory wording. " +
  "4) text must stay close to the JD's own wording. 5) kind: technical (skills/frameworks/tools), behavioural (soft skills/interaction), domain (industry/domain knowledge)." +
  "Return ONLY JSON matching the given schema.";

const COMPANY_BRIEF_SYSTEM =
  "You write a short impartial company primer for interview preparation. " +
  "Base it ONLY on the researched page snippets provided — do not invent facts or fetch new information. " +
  "summary: 1-2 sentences on what the company is. what_they_do: 2-3 sentences on products/business. " +
  "sources: only URLs from the provided page list that actually informed the brief (empty is fine). " +
  "Return ONLY JSON matching the given schema.";

// ---------- priority sanity check (best-effort, logs only, never gates) ----------

const MUSTY = /\b(required|must have|must|essential|mandatory|minimum of|years of experience|years' experience|\+\s?years)\b/i;
const NICEY = /\b(bonus|a plus|is a plus|preferred|nice to have|nice-to-have|desired|good to have|beneficial|not required|optional)\b/i;

/** Log a warning if priority looks contradictory with the requirement's own wording. */
function sanityCheckPriority(requirements: Requirement[]): void {
  for (const r of requirements) {
    const musty = MUSTY.test(r.text);
    const nicey = NICEY.test(r.text);
    if (r.priority === "must" && nicey && !musty) {
      console.warn(`[extraction] priority=must but text sounds like a nice-to-have: "${r.text}"`);
    } else if (r.priority === "nice" && musty && !nicey) {
      console.warn(`[extraction] priority=nice but text sounds mandatory: "${r.text}"`);
    }
  }
}

/** Stable, contiguous ids r1..rN regardless of what the model returned. */
function assignStableIds(requirements: Requirement[]): Requirement[] {
  return requirements.map((r, i) => ({ ...r, id: `r${i + 1}` }));
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return String(h);
}

interface RawExtract {
  title: string;
  seniority: string;
  responsibilities: string[];
  requirements: Array<{ id: string; text: string; kind: Requirement["kind"]; priority: Requirement["priority"] }>;
}

function normalizeRequirements(parsed: unknown): RawExtract {
  const p = parsed as RawExtract;
  const seen = new Set<string>();
  const requirements: Requirement[] = [];
  for (const item of (p?.requirements ?? []) as Array<{ text?: string; kind?: string; priority?: string }>) {
    const text = (item?.text ?? "").trim();
    if (!text) continue;
    const key = hash(text.toLowerCase());
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      id: "",
      text,
      kind: item.kind === "behavioural" || item.kind === "domain" ? item.kind : "technical",
      priority: item.priority === "nice" ? "nice" : "must",
    });
  }
  return {
    title: (p?.title ?? "").trim(),
    seniority: (p?.seniority ?? "").trim(),
    responsibilities: Array.isArray(p?.responsibilities) ? p.responsibilities.map((s) => s.trim()).filter(Boolean) : [],
    requirements,
  };
}

function pageContext(pages: CrawledPage[], company: string, maxChars = 2400): string {
  const parts: string[] = [];
  for (const page of pages.slice(0, 6)) {
    const snippet = page.text.slice(0, 700);
    parts.push(`[page] ${page.title || page.url}\n${snippet}`);
    if (parts.join("\n").length > maxChars) break;
  }
  return `Company researched: ${company}\n${parts.join("\n\n")}\n(snippet list: ${pages.map((p) => p.url).join(", ")})`;
}

function fmt(res: LLMCallResult): string {
  const m = res.metrics;
  return `${m.totalTokens} tok (${m.completionTokens} out) in ${m.durationMs}ms, ${m.attempts} attempt(s)`;
}

export class LlmExtractor implements Extractor {
  async extractRequirements(
    ctx: ExtractionContext,
  ): Promise<{ title: string; seniority: string; responsibilities: string[]; requirements: Requirement[] }> {
    const jd = ctx.jd.trim();
    const res = await callLLM(
      `Raw job description (may be truncated):\n"""\n${jd}\n"""\n\nExtract the requirements.`,
      { system: REQUIREMENTS_SYSTEM, schema: requirementsSchema, schemaName: "requirements" },
    );
    const parsed = normalizeRequirements(res.json);
    const withIds = assignStableIds(parsed.requirements);
    sanityCheckPriority(withIds);
    console.log(`[extraction] requirements: ${withIds.length} found (${fmt(res)})`);
    return { title: parsed.title, seniority: parsed.seniority, responsibilities: parsed.responsibilities, requirements: withIds };
  }

  async extractCompanyBrief(ctx: ExtractionContext): Promise<CompanyBrief> {
    const res = await callLLM(
      `Company: ${ctx.company}\n\nResearched page snippets:\n${pageContext(ctx.pages, ctx.company)}\n\nWrite the company primer.`,
      { system: COMPANY_BRIEF_SYSTEM, schema: companyBriefSchema, schemaName: "company_brief" },
    );
    const p = res.json as CompanyBrief;
    console.log(`[extraction] company brief: summary ${(p?.summary ?? "").length} chars (${fmt(res)})`);
    return {
      summary: (p?.summary ?? "").trim(),
      what_they_do: (p?.what_they_do ?? "").trim(),
      sources: Array.isArray(p?.sources) ? p.sources.filter((s) => typeof s === "string") : [],
    };
  }

  /** Pure heuristic — signals thin/absent JD sections so the UI can say so honestly. */
  async coverageGaps(ctx: ExtractionContext): Promise<string[]> {
    const jd = ctx.jd.trim();
    const gaps: string[] = [];
    if (jd.length === 0) gaps.push("jd: empty job description provided");
    else if (jd.length < 400) gaps.push(`jd: very thin (${jd.length} chars) — expect few or zero requirements; the kit stays honest and light`);
    if (ctx.pages.length === 0) gaps.push("company research: no pages were retrieved");
    return gaps;
  }
}

export function extractionFailureMessage(err: unknown): string {
  return err instanceof PipelineError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
}
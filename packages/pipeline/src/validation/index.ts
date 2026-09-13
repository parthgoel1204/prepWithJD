/**
 * Kit structure validation + one-model repair pass.
 *
 * Approach:
 * 1. Validate the full KitContent against a hand-written JSON Schema (type,
 *    enum, required fields, non-empty prompt/outline). This is the gate —
 *    fast, pure, zero LLM.
 * 2. If validation fails, decide whether the broken part is a small LLM-sourced
 *    substructure (company_brief, role.title/seniority/..., source.company). If
 *    so, send ONLY those failing fields back to the model once (≈600 tokens,
 *    never the full kit) asking for corrected values; otherwise no repair.
 * 3. Re-validate. Pass -> return the repaired kit; fail -> typed
 *    PipelineError(VALIDATION_FAILED).
 *
 * Why hand-written JSON Schema instead of Zod: this was Zod's slot, but zod v4
 * ships pure-ESM-with-top-level-await, which the repo's tsx/esbuild import path
 * for the pipeline package rejects (ERR_REQUIRE_ASYNC_MODULE). Reusing the
 * in-repo JsonSchema engine (llm/shape.ts — the same validator that gates Groq
 * strict responses, verify-llm 8/8) gives the same structural guarantees with
 * zero new runtime deps and one shared schema language.
 */
import { matchesShape, type JsonSchema } from "../llm/shape";
import { callLLM } from "../llm/client";
import { PipelineError } from "../errors";
import type { CompanyBrief, Flashcard, KitContent, KitSchedule, KitSource, Question, Requirement, RoleBreakdown, ScheduleDay, Coverage } from "../types";

// ---------- the exact KitContent mirror (hand-written) ----------

const enumRequirementKind: JsonSchema = { type: "string", enum: ["technical", "behavioural", "domain"] };
const enumRequirementPriority: JsonSchema = { type: "string", enum: ["must", "nice"] };
const enumQuestionCategory: JsonSchema = { type: "string", enum: ["technical", "behavioural", "system-design", "company-fit"] };

const scheduleDaySchema: JsonSchema = {
  type: "object",
  properties: {
    day: { type: "integer", minimum: 1 },
    focus: { type: "string" },
    question_ids: { type: "array", items: { type: "string" } },
    minutes: { type: "integer", minimum: 0 },
  },
  required: ["day", "focus", "question_ids", "minutes"],
  additionalProperties: false,
};

const kitScheduleSchema: JsonSchema = {
  type: "object",
  properties: {
    days_available: { type: "integer", minimum: 1 },
    days: { type: "array", items: scheduleDaySchema },
  },
  required: ["days_available", "days"],
  additionalProperties: false,
};

const coverageSchema: JsonSchema = {
  type: "object",
  properties: {
    uncovered_requirement_ids: { type: "array", items: { type: "string" } },
    passes: { type: "integer", minimum: 0 },
  },
  required: ["uncovered_requirement_ids", "passes"],
  additionalProperties: false,
};

const requirementSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", minimumLength: 1 },
    text: { type: "string", minimumLength: 1 },
    kind: enumRequirementKind,
    priority: enumRequirementPriority,
  },
  required: ["id", "text", "kind", "priority"],
  additionalProperties: false,
};

const roleBreakdownSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    seniority: { type: "string" },
    responsibilities: { type: "array", items: { type: "string" } },
    requirements: { type: "array", items: requirementSchema },
  },
  required: ["title", "seniority", "responsibilities", "requirements"],
  additionalProperties: false,
};

const companyBriefSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    what_they_do: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "what_they_do", "sources"],
  additionalProperties: false,
};

const kitSourceSchema: JsonSchema = {
  type: "object",
  properties: {
    company: { type: "string" },
    company_url: { type: "string" },
    role: { type: "string" },
    location: { type: "string" },
    jd_chars: { type: "integer", minimum: 0 },
    researched_at: { type: "string" },
    pages_used: { type: "array", items: { type: "string" } },
  },
  required: ["company", "company_url", "role", "location", "jd_chars", "researched_at", "pages_used"],
  additionalProperties: false,
};

export const kitContentSchema: JsonSchema = {
  type: "object",
  properties: {
    source: kitSourceSchema,
    company_brief: companyBriefSchema,
    role: roleBreakdownSchema,
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minimumLength: 1 },
          requirement_ids: { type: "array", items: { type: "string" } },
          category: enumQuestionCategory,
          prompt: { type: "string", minimumLength: 1 },
          answer_outline: { type: "string", minimumLength: 1 },
          difficulty: { type: "integer", minimum: 1, maximum: 3 },
        },
        required: ["id", "requirement_ids", "category", "prompt", "answer_outline", "difficulty"],
        additionalProperties: false,
      },
    },
    flashcards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minimumLength: 1 },
          front: { type: "string", minimumLength: 1 },
          back: { type: "string", minimumLength: 1 },
          requirement_ids: { type: "array", items: { type: "string" } },
        },
        required: ["id", "front", "back", "requirement_ids"],
        additionalProperties: false,
      },
    },
    schedule: kitScheduleSchema,
    coverage: coverageSchema,
  },
  required: ["source", "company_brief", "role", "questions", "flashcards", "schedule", "coverage"],
  additionalProperties: false,
} satisfies JsonSchema;

// ---------- validation entry point ----------

export type ValidationOk = { ok: true };
export type ValidationFail = { ok: false; errors: string[]; repairable: boolean };
export type ValidationResult = ValidationOk | ValidationFail;

/** Only these small, LLM-sourced substructures are worth a repair call. */
const REPAIRABLE_PREFIXES = ["$.company_brief", "$.role.title", "$.role.seniority", "$.role.responsibilities", "$.source.company"];

export function validateKitContent(kit: unknown): ValidationResult {
  const result = matchesShape(kit, kitContentSchema);
  if (result.ok) return { ok: true };
  const errors = result.errors;
  const repairable = errors.some((e) => REPAIRABLE_PREFIXES.some((p) => e.startsWith(`${p}:`) || e.startsWith(`${p}.`)));
  return { ok: false, errors, repairable };
}

function shortKitJson(kit: KitContent): string {
  const condensed = {
    company_brief: kit.company_brief,
    role: { title: kit.role.title, seniority: kit.role.seniority, responsibilities: kit.role.responsibilities },
    source_company: kit.source.company,
  };
  return JSON.stringify(condensed, null, 2);
}

// ---------- one repair pass ----------

const REPAIR_SYSTEM =
  "You fix structural JSON fields in an interview-preparation kit. " +
  "Only return the requested corrected fields. Return ONLY valid JSON — no markdown, no prose.";

export async function validateOrRepair(kit: KitContent, ctx?: { apiKey?: string }): Promise<KitContent> {
  const v = validateKitContent(kit);
  if (v.ok) return kit;
  if (!v.repairable) {
    throw new PipelineError(`Structural validation failed: ${v.errors.join("; ")}`, "VALIDATION_FAILED", "validation");
  }

  // Small repair payload: only the broken subset (brief/role fields), not the
  // full kit — token-budget safe.
  const prompt =
    `Structural validation failed on these fields:\n${v.errors.join("\n")}\n\n` +
    `Correct ONLY the failing fields (preserve text that was already sensible). Return a corrected JSON object matching this partial shape (all fields optional — include only what you fix):\n` +
    `{"company_brief":{"summary":"string","what_they_do":"string","sources":["string"]},"role":{"title":"string","seniority":"string","responsibilities":["string"]},"source":{"company":"string"}}\n\n` +
    `Current condensed values:\n${shortKitJson(kit)}`;

  try {
    const res = await callLLM(prompt, { system: REPAIR_SYSTEM, maxTokens: 1600, temperature: 0, schema: undefined, apiKey: ctx?.apiKey });
    const parsed = JSON.parse(res.text.trim()) as Record<string, unknown>;
    const repaired: KitContent = {
      ...kit,
      company_brief: parsed.company_brief ? { ...kit.company_brief, ...(parsed.company_brief as Partial<CompanyBrief>) } : kit.company_brief,
      role: parsed.role ? { ...kit.role, ...(parsed.role as Partial<RoleBreakdown>) } : kit.role,
      source: parsed.source ? { ...kit.source, ...(parsed.source as Partial<KitSource>) } : kit.source,
    };
    const v2 = validateKitContent(repaired);
    if (v2.ok) return repaired;
    throw new PipelineError(`Structural validation failed after repair: ${v2.errors.join("; ")}`, "VALIDATION_FAILED", "validation");
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    throw new PipelineError(`Repair call failed: ${err instanceof Error ? err.message : String(err)}; original errors: ${v.errors.join("; ")}`, "VALIDATION_FAILED", "validation");
  }
}
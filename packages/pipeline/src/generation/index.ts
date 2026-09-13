/**
 * Question generation (Day 2, real implementation).
 *
 * One LLM call PER category (technical | behavioural | system-design |
 * company-fit) — never one prompt asking for everything — and each category
 * call also returns its flashcards (the "derive in-category" decision from the
 * step-2 review, zero extra calls). Retrieved context from Day 1 (crawled
 * interview-format pages, Tavily discussion) is injected so it shapes which
 * questions get written (e.g. a known system-design round ups that category).
 *
 * Every question's requirement_ids is validated against the real extracted
 * requirements afterwards; anything referencing a nonexistent id is dropped
 * loudly, never silently kept.
 */
import type { CompanyBrief, CrawledPage, Flashcard, Question, QuestionCategory, Requirement, RoleBreakdown } from "../types";
import { PipelineNotImplementedError } from "../errors";
import { callLLM, type LLMCallResult } from "../llm/client";
import { matchesShape, type JsonSchema } from "../llm/shape";
import { computeUncovered, coverageResult, type CoverageResult } from "../coverage";
import { dedupeByIdentity, formatRequirements, sanitizeFlashcards, sanitizeQuestions } from "./pure";

export interface GenerationContext {
  jd: string;
  company: string;
  company_brief: CompanyBrief;
  role: RoleBreakdown;
  /** Extended (Day 2): Tavily interview-process discussion hits from retrieval. */
  discussion?: Array<{ title: string; url: string; snippet: string }>;
  /** Extended (Day 2): crawled pages carrying interview-format signal. */
  interviewPages?: CrawledPage[];
}

/** Question/flashcard generation. Must never add requirements absent from the JD. */
export interface Generator {
  generateQuestions(ctx: GenerationContext, requirements: Requirement[]): Promise<Question[]>;
  generateFlashcards(ctx: GenerationContext, requirements: Requirement[], questions: Question[]): Promise<Flashcard[]>;
}

export class NotImplementedGenerator implements Generator {
  async generateQuestions(_ctx: GenerationContext, _requirements: Requirement[]): Promise<Question[]> {
    throw new PipelineNotImplementedError("generation");
  }
  async generateFlashcards(
    _ctx: GenerationContext,
    _requirements: Requirement[],
    _questions: Question[],
  ): Promise<Flashcard[]> {
    throw new PipelineNotImplementedError("generation");
  }
}

// ---------- schemas (hand-written; Groq-strict compatible) ----------

const questionItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", maximumLength: 8, description: "placeholder — ids are re-assigned deterministically" },
    category: { type: "string", enum: ["technical", "behavioural", "system-design", "company-fit"] },
    requirement_ids: { type: "array", items: { type: "string", maximumLength: 8 }, description: "real requirement ids this question assesses (must all exist)" },
    prompt: { type: "string", maximumLength: 1200, description: "a specific, answerable interview question" },
    answer_outline: { type: "string", maximumLength: 2500, description: "3-5 tight bullet key points the answer should hit" },
    difficulty: { type: "integer", minimum: 1, maximum: 3, description: "1 (warm-up) to 3 (hard)" },
  },
  required: ["id", "category", "requirement_ids", "prompt", "answer_outline", "difficulty"],
};

const flashcardItemSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", maximumLength: 8, description: "placeholder" },
    front: { type: "string", maximumLength: 500, description: "short recall prompt" },
    back: { type: "string", maximumLength: 1200, description: "the fact/definition to recall" },
    requirement_ids: { type: "array", items: { type: "string", maximumLength: 8 } },
  },
  required: ["id", "front", "back", "requirement_ids"],
};

function categoryCallSchema(category: QuestionCategory): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      category: { type: "string", enum: [category] },
      questions: { type: "array", items: questionItemSchema },
      flashcards: { type: "array", items: flashcardItemSchema },
    },
    required: ["category", "questions", "flashcards"],
  };
}

const gapCallSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: { type: "array", items: questionItemSchema },
    flashcards: { type: "array", items: flashcardItemSchema },
  },
  required: ["questions", "flashcards"],
};

// ---------- prompts ----------

const Q_SYSTEM_BASE =
  "You are an interview-preparation question writer for ONE specific job posting. " +
  "Ground every question ONLY in the provided requirements and researched context — never invent additional requirements, " +
  "skills, or industry-standard expectations. A question may assess multiple requirements. " +
  "answer_outline: 3-5 CONCISE key points (2-4 sentences total, tight bullets). difficulty: 1 (warm-up), 2 (standard), 3 (hard). " +
  "Write exactly the number of questions requested; fewer is fine when few requirements are relevant, and an empty list is valid. " +
  "Also produce flashcards (one short front/back card per key fact that benefits from spaced repetition) for the material you wrote. " +
  "Return ONLY JSON matching the given schema.";

const CATEGORY_NOTES: Record<QuestionCategory, string> = {
  technical: "Deep-dive technical questions on the technical/domain requirements (e.g. toolchain, fundamentals, tradeoffs, debugging).",
  behavioural: "STAR-method behavioural questions mapped to the behavioural (and relevant soft-skill) requirements.",
  "system-design": "System-design / whiteboard questions. Only where the requirements or researched interview format justify them; if the role is nothing like that, return an empty questions list.",
  "company-fit": "Company-fit / culture / why-us questions, informed by the company brief and any interview-format context.",
};

function interviewContextCtx(ctx: GenerationContext): string {
  const pages = ctx.interviewPages ?? [];
  const parts: string[] = [];
  for (const p of pages.slice(0, 2)) parts.push(`[crawled page] ${p.title || p.url}: ${p.text.slice(0, 600)}`);
  const disc = ctx.discussion ?? [];
  for (const d of disc.slice(0, 5)) parts.push(`[discussion hit] ${d.title} — ${d.snippet.slice(0, 260)}`);
  return parts.length
    ? `Retrieved context (used only as signal for which rounds/formats exist — cite it in answers where relevant):\n${parts.join("\n")}`
    : "No retrieved interview-format context was available.";
}

function roleBlock(ctx: GenerationContext): string {
  const r = ctx.role;
  const lines = [`Role: ${r.title || "?"}${r.seniority ? ` (${r.seniority})` : ""}`];
  if (r.responsibilities.length) lines.push(`Responsibilities:\n- ${r.responsibilities.join("\n- ")}`);
  lines.push(`Requirements:\n${formatRequirements(r.requirements)}`);
  if (ctx.company_brief?.summary) lines.push(`Company brief: ${ctx.company_brief.summary}`);
  return lines.join("\n");
}

function fmt(res: LLMCallResult): string {
  const m = res.metrics;
  return `${m.totalTokens} tok in ${m.durationMs}ms, ${m.attempts} attempt(s)`;
}

interface CategoryBatchOutcome {
  questions: Question[];
  flashcards: Flashcard[];
  dropped: string[];
}

export class LlmGenerator implements Generator {
  /** Cards written during generateQuestions, surfaced by generateFlashcards without a new call. */
  private lastCards: Flashcard[] = [];

  /**
   * First draft only (no second pass). Kept for interface compatibility and
   * verification; the production path is generateSet() which owns the coverage
   * loop.
   */
  async generateQuestions(ctx: GenerationContext, requirements: Requirement[]): Promise<Question[]> {
    if (requirements.length === 0) {
      console.log(`[generation] pass1: 0 questions (no requirements to anchor to)`);
      this.lastCards = [];
      return [];
    }
    const pass1 = await this.pass1(ctx, requirements);
    this.lastCards = dedupeByIdentity(pass1.cards);
    console.log(`[generation] pass1: ${pass1.questions.length} questions, ${this.lastCards.length} flashcards`);
    return dedupeByIdentity(pass1.questions);
  }

  /**
   * Full orchestration with the coverage second-pass loop (Step 5):
   *   pass1 (4 category calls) -> pure coverage check -> if uncovered "must"
   *   requirements exist, ONE gap-batch call targeting only those -> merge ->
   *   re-check. Capped at `maxPasses` generations total.
   *
   * Why cap at 2: a second pass catches systematic category misses; further
   * gap passes on the free tier burn tokens for marginal recall and tend to
   * reproduce the same miss pattern against the same retrieved context. Honest
   * leftovers are kept listed in coverage.uncovered_requirement_ids.
   */
  async generateSet(ctx: GenerationContext, requirements: Requirement[], maxPasses = 2): Promise<{ questions: Question[]; flashcards: Flashcard[]; coverage: CoverageResult }> {
    if (requirements.length === 0) {
      console.log(`[generation] pass1: 0 questions (no requirements to anchor to)`);
      this.lastCards = [];
      const coverage = coverageResult({ requirements, questions: [] }, 1);
      return { questions: [], flashcards: [], coverage };
    }

    const pass1 = await this.pass1(ctx, requirements);
    let questions = pass1.questions;
    let cards = pass1.cards;
    let passes = 1;
    const uncovered = computeUncovered({ requirements, questions });
    console.log(`[generation] pass1: ${questions.length} questions, uncovered musts: ${JSON.stringify(uncovered)}`);

    if (uncovered.length > 0 && passes < maxPasses) {
      const gap = await this.generateGapBatch(ctx, requirements, uncovered, questions.length, cards.length);
      for (const d of gap.dropped) console.warn(`[generation] pass2: ${d}`);
      questions = dedupeByIdentity([...questions, ...gap.questions]);
      cards = dedupeByIdentity([...cards, ...gap.flashcards]);
      passes++;
      const after = computeUncovered({ requirements, questions });
      console.log(`[generation] pass2: ${gap.questions.length} gap questions closed ${uncovered.length - after.length}/${uncovered.length} gaps; still uncovered: ${JSON.stringify(after)}`);
    }

    this.lastCards = cards;
    const coverage = coverageResult({ requirements, questions }, passes);
    return { questions, flashcards: cards, coverage };
  }

  private async pass1(ctx: GenerationContext, requirements: Requirement[]): Promise<{ questions: Question[]; cards: Flashcard[] }> {
    const known = new Set(requirements.map((r) => r.id));
    const allQuestions: Question[] = [];
    const allCards: Flashcard[] = [];
    const dropped: string[] = [];

    for (const category of ["technical", "behavioural", "system-design", "company-fit"] as QuestionCategory[]) {
      const batch = await this.generateCategory(category, ctx, requirements, known, allQuestions.length, allCards.length);
      dropped.push(...batch.dropped);
      allQuestions.push(...batch.questions);
      allCards.push(...batch.flashcards);
    }

    for (const d of dropped) console.warn(`[generation] ${d}`);
    return { questions: dedupeByIdentity(allQuestions), cards: dedupeByIdentity(allCards) };
  }

  async generateFlashcards(ctx: GenerationContext, requirements: Requirement[], questions: Question[]): Promise<Flashcard[]> {
    // Cards were produced in-category during generateQuestions (no separate LLM
    // call — token budget). If flashcards were asked for standalone, derive
    // deterministic cards from the questions' prompts/outlines.
    if (this.lastCards.length) return this.lastCards;
    const known = new Set(requirements.map((r) => r.id));
    const cards = questions
      .filter((q) => q.requirement_ids.length > 0)
      .map((q) => ({ id: "", front: q.prompt, back: q.answer_outline, requirement_ids: q.requirement_ids }))
      .filter((c) => known.has(c.requirement_ids[0]!));
    return dedupeByIdentity(cards);
  }

  /** Second-pass: questions ONLY for the given gap requirement ids (single call). */
  async generateGapBatch(ctx: GenerationContext, requirements: Requirement[], targetIds: string[], qStart = 0, fStart = 0): Promise<CategoryBatchOutcome> {
    const known = new Set(requirements.map((r) => r.id));
    const targets = targetIds.filter((id) => known.has(id));
    const prompt =
      `Only these requirements are uncovered — write questions for THEM specifically:\n` +
      formatRequirements(requirements.filter((r) => targets.includes(r.id))) +
      `\n\nChoose the most relevant category for each question. Fewer is fine if only a couple of requirements are listed.\n` +
      interviewContextCtx(ctx);

    const res = await callLLM(prompt, { system: Q_SYSTEM_BASE, schema: gapCallSchema, schemaName: "gap_questions" });
    const parsed = res.json as { questions?: Array<{ requirement_ids?: string[]; prompt?: string; answer_outline?: string; difficulty?: number }>; flashcards?: Array<{ front?: string; back?: string; requirement_ids?: string[] }> };
    const q = sanitizeQuestions(parsed.questions ?? [], known, qStart);
    const f = sanitizeFlashcards(parsed.flashcards ?? [], known, fStart);
    return { questions: q.questions, flashcards: f.flashcards, dropped: [...q.dropped, ...f.dropped] };
  }

  private async generateCategory(
    category: QuestionCategory,
    ctx: GenerationContext,
    requirements: Requirement[],
    known: Set<string>,
    qStart: number,
    fStart: number,
  ): Promise<CategoryBatchOutcome> {
    const relevant = requirements.slice();
    const target = Math.min(3, Math.max(1, relevant.length));
    const prompt =
      `${CATEGORY_NOTES[category]}\n\n` +
      `How many questions to write: ${target} (for ${category} relevance only — fewer allowed).\n` +
      `${roleBlock(ctx)}\n\n${interviewContextCtx(ctx)}\n\nCategory: ${category}.` +
      (category === "company-fit" && (ctx.discussion?.length ?? 0) > 0
        ? " Interview-process discussion hits are above: fold any concrete format details into company-fit/system-design answers."
        : "");

    const res = await callLLM(prompt, { system: Q_SYSTEM_BASE, schema: categoryCallSchema(category), schemaName: `questions_${category}` });
    const parsed = res.json as { questions?: Array<{ requirement_ids?: string[]; category?: string; prompt?: string; answer_outline?: string; difficulty?: number }>; flashcards?: Array<{ front?: string; back?: string; requirement_ids?: string[] }> };
    const q = sanitizeQuestions(parsed.questions ?? [], known, qStart);
    // per-category call: force the category we invoked — a rogue category from the
    // model would otherwise double-count a category in the merged output.
    q.questions = q.questions.map((x) => ({ ...x, category }));
    const f = sanitizeFlashcards(parsed.flashcards ?? [], known, fStart);
    for (const d of q.dropped) console.warn(`[generation] ${category}: ${d}`);
    for (const d of f.dropped) console.warn(`[generation] ${category}: ${d}`);
    console.log(`[generation] ${category}: ${q.questions.length} questions, ${f.flashcards.length} flashcards (${fmt(res)})`);
    return { questions: q.questions, flashcards: f.flashcards, dropped: [] as string[] };
  }
}

export { categoryOf } from "./pure";
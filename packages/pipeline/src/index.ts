import type { CompanyBrief, EvaluateInput, EvaluateOutput, Flashcard, KitContent, KitInput, KitSchedule, KitStageError, Question, RetrievalOptions, RetrievalResult, RoleBreakdown } from "./types";
import { companyNameFromUrl, nowIso } from "./lib/util";
import { resolveRetrievalOptions } from "./retrieval/options";
import { crawlSite } from "./retrieval/crawler";
import { LlmExtractor } from "./extraction";
import { LlmGenerator, type GenerationContext } from "./generation";
import { buildSchedule } from "./scheduling";
import { validateOrRepair } from "./validation";
import { PipelineError } from "./errors";

export { connectDb, disconnectDb, isConnected } from "./persistence/connect";
export * as models from "./persistence/models";
export { UserModel } from "./persistence/models";
export {
  createUser,
  findUserByEmail,
  findUserById,
  createSession,
  findSession,
  deleteSession,
  deleteExpiredSessions,
  createKit,
  listKits,
  findKitById,
  updateKitStatus,
  deleteKit,
  persistRetrieval,
  persistFailedKit,
  recordSourceFailures,
  listSourceFailures,
} from "./persistence/repositories";
export { resolveRetrievalOptions } from "./retrieval/options";
export { companyNameFromUrl, hostnameOf } from "./lib/util";
export type { RetrievalOptions, RetrievalResult } from "./types";

export const PIPELINE_VERSION = "0.2.0";

const INTERVIEW_SIGNAL = /\b(interview|interview(s)? process|hiring|onboarding|candidat(e|es)|recruit|round|careers)\b/i;

/** Stage 1 — research a company. Web UI and CLI both call this (no parallel code). */
export async function runRetrieval(input: Pick<KitInput, "company_url">, opts?: RetrievalOptions): Promise<RetrievalResult> {
  const resolved = resolveRetrievalOptions(opts);
  const { draft, failures } = await crawlSite(input.company_url, resolved);
  return {
    company: draft.company,
    pages: draft.pages,
    pages_used: draft.pages_used,
    search_hits: draft.search_hits,
    robots_blocked: draft.robots_blocked,
    failures,
  };
}

/**
 * Full pipeline: retrieval -> extraction -> generation(+coverage loop) ->
 * scheduling -> validation.
 *
 * Log-and-continue: every stage is isolated. Degraded stages are recorded as
 * structured KitStageError on the kit (page/source unreachable, an LLM call
 * 429'd, one category failed...) WITHOUT failing the kit. A kit is only failed
 * when it truly cannot be produced:
 *   - extraction's LLM is unreachable AND zero requirements came out, or
 *   - the completed kit fails structural validation even after the repair pass
 *     (something invalid must never reach persistence or batch output).
 *
 * Validation runs before returning, so callers (API route, batch CLI) only ever
 * persist/output a structurally valid KitContent.
 */
export async function runPipeline(input: Pick<KitInput, "jd" | "company_url" | "days">, opts?: RetrievalOptions): Promise<KitContent> {
  const started = Date.now();
  const stageErrors: KitStageError[] = [];
  const record = (stage: string, err: unknown) => {
    const code = err instanceof PipelineError ? err.code : "STAGE_FAILED";
    stageErrors.push({ stage, code, message: err instanceof Error ? err.message : String(err), occurred_at: nowIso() });
  };
  const jd = input.jd.trim();

  // ---- retrieval (fail-soft; per-page failures already fail-safe inside) ----
  let retrieval: RetrievalResult;
  try {
    retrieval = await runRetrieval(input, opts);
  } catch (err) {
    record("retrieval", err);
    console.warn(`[pipeline] retrieval degraded: ${err instanceof Error ? err.message : err}`);
    retrieval = {
      company: companyNameFromUrl(input.company_url),
      pages: [],
      pages_used: [],
      search_hits: { items: [], failures: [] },
      robots_blocked: [],
      failures: [],
    };
  }
  for (const f of retrieval.failures) console.warn(`[pipeline] retrieval: ${f.source_url} -> ${f.code} ${f.message}`);

  // ---- extraction (real LLM) ----
  const extractor = new LlmExtractor();
  let role: RoleBreakdown = { title: "", seniority: "", responsibilities: [], requirements: [] };
  let company_brief: CompanyBrief = { summary: "", what_they_do: "", sources: [] };
  try {
    const extractCtx = { jd, company: retrieval.company, pages: retrieval.pages };
    const extracted = await extractor.extractRequirements(extractCtx);
    role = { title: extracted.title, seniority: extracted.seniority, responsibilities: extracted.responsibilities, requirements: extracted.requirements };
    company_brief = await extractor.extractCompanyBrief(extractCtx);
  } catch (err) {
    record("extraction", err);
    console.warn(`[pipeline] extraction degraded: ${err instanceof Error ? err.message : err}`);
    // Truly unproducible: the requirement-extraction LLM is unreachable AND no
    // requirements exist to anchor a kit on. Otherwise we continue honestly.
    const code = err instanceof PipelineError ? err.code : "";
    if (code.startsWith("LLM_") && role.requirements.length === 0) {
      throw new PipelineError(`Kit unproducible: extraction LLM unreachable and zero requirements extracted. ${err instanceof Error ? err.message : err}`, "KIT_UNPRODUCIBLE", "extraction");
    }
  }

  // ---- generation (4 in-category calls + coverage second-pass loop) ----
  const interviewPages = retrieval.pages.filter((p) => INTERVIEW_SIGNAL.test(`${p.title} ${p.text.slice(0, 300)}`));
  const genCtx: GenerationContext = {
    jd,
    company: retrieval.company,
    company_brief,
    role,
    discussion: retrieval.search_hits.items,
    interviewPages,
  };
  const generator = new LlmGenerator();
  let questions: Question[] = [];
  let flashcards: Flashcard[] = [];
  let coverage = { uncovered_requirement_ids: role.requirements.map((r) => r.id), passes: 1 };
  try {
    const set = await generator.generateSet(genCtx, role.requirements, 2);
    questions = set.questions;
    flashcards = set.flashcards;
    coverage = set.coverage;
  } catch (err) {
    record("generation", err);
    console.warn(`[pipeline] generation degraded: ${err instanceof Error ? err.message : err}`);
  }

  // ---- scheduling (pure, deterministic) ----
  let schedule: KitSchedule;
  try {
    schedule = buildSchedule(role.requirements, questions, input.days);
  } catch (err) {
    record("scheduling", err);
    schedule = { days_available: Math.max(1, Math.floor(input.days)), days: [] };
  }

  const kit: KitContent = {
    source: {
      company: retrieval.company,
      company_url: input.company_url,
      role: role.title,
      location: "",
      jd_chars: jd.length,
      researched_at: nowIso(),
      pages_used: retrieval.pages_used,
      discussion: retrieval.search_hits.items.length ? retrieval.search_hits.items : undefined,
      robots_blocked: retrieval.robots_blocked.length ? retrieval.robots_blocked : undefined,
    },
    company_brief,
    role,
    questions,
    flashcards,
    schedule,
    coverage,
    stage_errors: stageErrors,
  };

  // ---- validation gate: only structurally valid kits leave the pipeline ----
  try {
    const validated = await validateOrRepair(kit);
    console.log(
      `[pipeline] ${input.company_url}: ${role.requirements.length} reqs, ${questions.length} questions (${coverage.passes} pass(es), ${coverage.uncovered_requirement_ids.length} uncovered), ${flashcards.length} cards, ${schedule.days.length} days in ${Date.now() - started}ms`,
    );
    return validated;
  } catch (err) {
    record("validation", err);
    throw err;
  }
}

/**
 * Batch entrypoint. The Day-2 CLI is a thin argument parser over this function —
 * identical code path to the web app. Each input is isolated so one failure
 * never aborts the rest.
 */
export async function evaluate(inputs: EvaluateInput[], opts?: RetrievalOptions): Promise<EvaluateOutput> {
  const kits: EvaluateOutput["kits"] = [];
  for (const input of inputs) {
    try {
      const kit = await runPipeline({ jd: input.jd, company_url: input.company_url, days: input.days }, opts);
      kits.push({ id: input.id, status: "ok", kit, error: null });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      kits.push({ id: input.id, status: "failed", kit: null, error });
    }
  }
  return { version: PIPELINE_VERSION, generated_at: nowIso(), kits };
}
import type { EvaluateInput, EvaluateOutput, KitContent, KitInput, RetrievalOptions, RetrievalResult, RoleBreakdown } from "./types";
import { nowIso } from "./lib/util";
import { resolveRetrievalOptions } from "./retrieval/options";
import { crawlSite } from "./retrieval/crawler";
import { NotImplementedExtractor } from "./extraction";
import { NotImplementedGenerator } from "./generation";
import { NotImplementedScheduler } from "./scheduling";

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

export const PIPELINE_VERSION = "0.1.0";

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
 * Full pipeline: retrieval -> extraction -> generation -> scheduling.
 * Today extraction/generation/scheduling are Day-1 stubs and throw NOT_IMPLEMENTED —
 * so a full run fails loudly instead of persisting fabricated content. Substituting
 * real implementations (Day 2) is the only change needed.
 */
export async function runPipeline(input: Pick<KitInput, "jd" | "company_url" | "days">, opts?: RetrievalOptions): Promise<KitContent> {
  const retrieval = await runRetrieval(input, opts);
  const jd = input.jd.trim();
  const ctx = { jd, company: retrieval.company, pages: retrieval.pages };

  const extractor = new NotImplementedExtractor();
  const generator = new NotImplementedGenerator();
  const scheduler = new NotImplementedScheduler();

  // Extraction (J2): grounded only in the JD + researched pages.
  const extracted = await extractor.extractRequirements(ctx);
  const company_brief = await extractor.extractCompanyBrief(ctx);

  const role: RoleBreakdown = {
    title: extracted.title,
    seniority: extracted.seniority,
    responsibilities: extracted.responsibilities,
    requirements: extracted.requirements,
  };

  // Generation (must never add requirements absent from the JD).
  const generationCtx = { jd, company: retrieval.company, company_brief, role };
  const questions = await generator.generateQuestions(generationCtx, extracted.requirements);
  const flashcards = await generator.generateFlashcards(generationCtx, extracted.requirements, questions);

  // Scheduling.
  const schedule = await scheduler.buildSchedule({ daysAvailable: input.days, questions });

  return {
    source: {
      company: retrieval.company,
      company_url: input.company_url,
      role: role.title,
      location: "",
      jd_chars: jd.length,
      researched_at: nowIso(),
      pages_used: retrieval.pages_used,
    },
    company_brief,
    role,
    questions,
    flashcards,
    schedule,
    coverage: {
      uncovered_requirement_ids: extracted.requirements.map((r) => r.id),
      passes: 0,
    },
  };
}

/**
 * Batch entrypoint. The Day-2 CLI becomes a thin argument parser over this function —
 * identical code path to the web app. Each input is isolated so one failure never
 * aborts the rest.
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
import { Router, type Request, type Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import {
  runRetrieval,
  runPipeline,
  createKit,
  listKits,
  findKitById,
  updateKitStatus,
  persistRetrieval,
  persistGeneratedKit,
  persistFailedKit,
  saveKitContent,
  regenerateCompanyBrief,
  regenerateQuestionCategory,
  regenerateSchedule,
  recordSourceFailures,
  listSourceFailures,
  deleteKit,
  resolveRetrievalOptions,
} from "@prepwithjd/pipeline";
import type { KitContent, RetrievalResult } from "@prepwithjd/pipeline";
import { asyncH, HttpError, paramStr } from "../lib/http";
import { requireAuth } from "../middleware/auth";

const kitInputSchema = z.object({
  jd: z.string().trim().min(1, "job description is required").max(50_000),
  company_url: z.string().trim().min(4, "company URL is required").max(2048),
  days: z.coerce.number().int().min(1, "days must be between 1 and 60").max(60).default(5),
});

const batchSchema = z.object({
  items: z
    .array(kitInputSchema)
    .min(1, "at least one item is required")
    .max(100, "batch is capped at 100 items"),
});

const questionCategory = z.enum(["technical", "behavioural", "system-design", "company-fit"]);

/** Builder edits (Day 3 scope). One op per request; server applies it to the
 *  current persisted content, so a stale client copy can never clobber fields
 *  written elsewhere (still a single read-modify-write per call). */
const contentPatchSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update-item"),
    target: z.enum(["questions", "flashcards"]),
    id: z.string().min(1),
    field: z.enum(["prompt", "answer_outline", "front", "back"]),
    value: z.string().max(20_000),
  }),
  z.object({
    op: z.literal("update-brief"),
    field: z.literal("summary"),
    value: z.string().max(10_000),
  }),
  z.object({
    op: z.literal("add-question"),
    category: questionCategory,
    prompt: z.string().trim().min(1, "prompt is required").max(10_000),
    answer_outline: z.string().max(20_000).optional().default(""),
    requirement_ids: z.array(z.string()).max(50).optional().default([]),
    difficulty: z.number().int().min(1).max(3).optional().default(2),
  }),
  z.object({
    op: z.literal("add-flashcard"),
    front: z.string().trim().min(1, "front is required").max(1_000),
    back: z.string().trim().min(1, "back is required").max(5_000),
    requirement_ids: z.array(z.string()).max(50).optional().default([]),
  }),
  z.object({
    op: z.literal("remove-item"),
    target: z.enum(["questions", "flashcards"]),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("reorder-questions"),
    category: questionCategory,
    ordered_ids: z.array(z.string()).min(1),
  }),
  z.object({
    op: z.literal("practice"),
    card_id: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
  }),
  z.object({
    op: z.literal("regenerate-brief"),
  }),
  z.object({
    op: z.literal("regenerate-category"),
    category: questionCategory,
  }),
  z.object({
    op: z.literal("regenerate-schedule"),
  }),
]);

/** Stable next id matching the pipeline's cursor scheme (q1, q2, …, f1, f2, …). */
function nextItemId(prefix: "q" | "f", existing: Array<{ id: string }>): string {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const item of existing) {
    const m = re.exec(item.id);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return `${prefix}${max + 1}`;
}

/** Reorder questions within one category, preserving other categories' order. */
function reorderQuestions(content: KitContent, category: string, orderedIds: string[]): KitContent {
  const byCategory = new Map<string, KitContent["questions"]>();
  for (const q of content.questions) {
    const list = byCategory.get(q.category) ?? [];
    list.push(q);
    byCategory.set(q.category, list);
  }
  const target = byCategory.get(category) ?? [];
  const expected = new Set(target.map((q) => q.id));
  if (expected.size !== orderedIds.length || !orderedIds.every((id) => expected.has(id))) {
    throw new HttpError(400, "VALIDATION", "ordered_ids must contain exactly the current question ids in this category");
  }
  const position = new Map(orderedIds.map((id, i) => [id, i]));
  const sorted = [...target].sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  byCategory.set(category, sorted);
  const reordered: KitContent["questions"] = [];
  for (const list of byCategory.values()) reordered.push(...list);
  return { ...content, questions: reordered };
}

function applyContentPatch(content: KitContent, patch: z.infer<typeof contentPatchSchema>): KitContent {
  switch (patch.op) {
    case "update-item": {
      if (patch.target === "questions") {
        const item = content.questions.find((i) => i.id === patch.id);
        if (!item) throw new HttpError(404, "NOT_FOUND", "Question not found");
        if (patch.field === "prompt") item.prompt = patch.value;
        else item.answer_outline = patch.value;
        item.edited = true;
      } else {
        const item = content.flashcards.find((i) => i.id === patch.id);
        if (!item) throw new HttpError(404, "NOT_FOUND", "Flashcard not found");
        if (patch.field === "front") item.front = patch.value;
        else item.back = patch.value;
        item.edited = true;
      }
      return content;
    }
    case "update-brief": {
      content.company_brief.summary = patch.value;
      content.company_brief.edited = true;
      return content;
    }
    case "add-question": {
      content.questions.push({
        id: nextItemId("q", content.questions),
        requirement_ids: patch.requirement_ids,
        category: patch.category,
        prompt: patch.prompt,
        answer_outline: patch.answer_outline,
        difficulty: patch.difficulty,
        edited: true,
      });
      return content;
    }
    case "add-flashcard": {
      content.flashcards.push({
        id: nextItemId("f", content.flashcards),
        front: patch.front,
        back: patch.back,
        requirement_ids: patch.requirement_ids,
        edited: true,
      });
      return content;
    }
    case "remove-item": {
      if (patch.target === "questions") {
        const next = content.questions.filter((i) => i.id !== patch.id);
        if (next.length === content.questions.length) throw new HttpError(404, "NOT_FOUND", "Question not found");
        content.questions = next;
      } else {
        const next = content.flashcards.filter((i) => i.id !== patch.id);
        if (next.length === content.flashcards.length) throw new HttpError(404, "NOT_FOUND", "Flashcard not found");
        content.flashcards = next;
      }
      return content;
    }
    case "reorder-questions":
      return reorderQuestions(content, patch.category, patch.ordered_ids);
    case "practice": {
      const entries = content.practice ?? [];
      const existing = entries.findIndex((e) => e.cardId === patch.card_id);
      const entry = { cardId: patch.card_id, confidence: patch.confidence, lastSeenAt: new Date().toISOString() };
      if (existing === -1) entries.push(entry);
      else entries[existing] = entry;
      content.practice = entries;
      return content;
    }
    // Regenerate ops are async and handled in the route; keep the switch exhaustive.
    case "regenerate-brief":
    case "regenerate-category":
    case "regenerate-schedule":
      return content;
  }
}

/** Merge a fresh retrieval result into the persisted source block (shared by
 * the standalone retrieve route and the generate route's auto-retrieve step). */
function withSource(content: KitContent, result: RetrievalResult, jd: string, companyUrl: string): KitContent {
  return {
    ...content,
    source: {
      ...content.source,
      company: result.company || content.source.company,
      company_url: companyUrl,
      jd_chars: jd.length,
      researched_at: new Date().toISOString(),
      pages_used: result.pages_used,
      discussion: result.search_hits.items.map((i) => ({ title: i.title, url: i.url, snippet: i.snippet })),
      robots_blocked: result.robots_blocked.map((b) => ({ url: b.url, via: b.via, rule: b.rule })),
    },
  };
}

export const kitsRouter = Router();
kitsRouter.use(requireAuth);

// Create a single draft (raw input persisted — generation comes on Day 2).
kitsRouter.post(
  "/",
  asyncH(async (req: Request, res: Response) => {
    const parsed = kitInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { jd, company_url, days } = parsed.data;
    const kit = await createKit({ userId: req.user!._id, jd, company_url, days });
    res.status(201).json({ kit });
  }),
);

// Batch: accept a JSON file of {jd, company_url, days} pairs.
kitsRouter.post(
  "/batch",
  asyncH(async (req: Request, res: Response) => {
    const parsed = batchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION", parsed.error.issues.map((i) => i.message).join("; "));
    }
    const created = [];
    for (const item of parsed.data.items) {
      const kit = await createKit({ userId: req.user!._id, ...item });
      created.push(kit);
    }
    res.status(201).json({ count: created.length, kits: created });
  }),
);

kitsRouter.get(
  "/",
  asyncH(async (req: Request, res: Response) => {
    const kits = await listKits(req.user!._id);
    res.json({ kits });
  }),
);

kitsRouter.get(
  "/:id",
  asyncH(async (req: Request, res: Response) => {
    const kit = await findKitById(paramStr(req, "id"));
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");
    res.json({ kit });
  }),
);

kitsRouter.delete(
  "/:id",
  asyncH(async (req: Request, res: Response) => {
    const kit = await findKitById(paramStr(req, "id"));
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");
    await deleteKit(paramStr(req, "id"));
    res.json({ ok: true });
  }),
);

// Builder edit endpoint (Day 3): one targeted op applied to the persisted content.
kitsRouter.patch(
  "/:id/content",
  asyncH(async (req: Request, res: Response) => {
    const id = paramStr(req, "id");
    const kit = await findKitById(id);
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");

    const parsed = contentPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION", parsed.error.issues.map((i) => i.message).join("; "));
    }

    let content = structuredClone(kit.content) as KitContent;
    const patch = parsed.data;
    if (patch.op === "regenerate-brief") content = await regenerateCompanyBrief(content, kit.input);
    else if (patch.op === "regenerate-category") content = await regenerateQuestionCategory(content, kit.input, patch.category);
    else if (patch.op === "regenerate-schedule") content = regenerateSchedule(content);
    else content = applyContentPatch(content, patch);

    await saveKitContent(id, content);
    res.json({ kit: { ...kit, content } });
  }),
);

// Failure records for a kit (log-and-continue source diagnostics, newest first).
kitsRouter.get(
  "/:id/failures",
  asyncH(async (req: Request, res: Response) => {
    const id = paramStr(req, "id");
    const kit = await findKitById(id);
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");
    const failures = await listSourceFailures(id, req.user!._id);
    res.json({ failures });
  }),
);

// Retrieval-override knobs (e.g. shrink timeoutMs for timeout tests); default otherwise.
const retryOptsSchema = z.object({
  timeoutMs: z.coerce.number().int().min(500).max(60_000).optional(),
  retries: z.coerce.number().int().min(0).max(6).optional(),
});

// Run retrieval for a saved draft. Persists pages_used + source failures.
kitsRouter.post(
  "/:id/retrieve",
  asyncH(async (req: Request, res: Response) => {
    const id = Types.ObjectId.isValid(paramStr(req, "id")) ? paramStr(req, "id") : "";

    const kit = id ? await findKitById(id) : null;
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");

    const parsedOpts = retryOptsSchema.safeParse(req.body ?? {});
    if (!parsedOpts.success) {
      throw new HttpError(400, "VALIDATION", parsedOpts.error.issues.map((i) => i.message).join("; "));
    }
    const opts = resolveRetrievalOptions(parsedOpts.data);
    await updateKitStatus(id, "retrieving");

    let result;
    try {
      result = await runRetrieval({ company_url: kit.input.company_url }, opts);
    } catch (err) {
      await persistFailedKit(id, err instanceof Error ? err.message : String(err));
      throw err;
    }

    const content = withSource(kit.content, result, kit.input.jd, kit.input.company_url);

    await persistRetrieval(id, content);
    await recordSourceFailures(req.user!._id, id, result.failures);

    res.json({
      kit: { ...kit, status: "retrieved", content },
      retrieval: {
        pages_used: result.pages_used,
        pages: result.pages.map((p) => ({ url: p.url, title: p.title, depth: p.depth })),
        search_hits: result.search_hits.items,
        robots_blocked: result.robots_blocked,
        failures: result.failures,
      },
    });
  }),
);

// Generate the real kit: one-click flow. If the kit is still a draft (or was
// failed/retrying), auto-triggers the retrieval stage FIRST, persists it, and
// only then runs extraction -> generation(+coverage loop) -> scheduling ->
// validation. Retrieval and generation stay separate internal pipeline stages;
// this route just chains them. The fresh retrieval result is injected into
// runPipeline so the site is not crawled twice. Same code path as the CLI.
// The full builder UI (edit/reorder/regenerate-one-section) is Day 3 scope.
kitsRouter.post(
  "/:id/generate",
  asyncH(async (req: Request, res: Response) => {
    const id = paramStr(req, "id");
    const kit = await findKitById(id);
    if (!kit || !kit.userId.equals(req.user!._id)) throw new HttpError(404, "NOT_FOUND", "Kit not found");

    let preRetrieved: RetrievalResult | undefined;
    if (kit.status !== "retrieved" && kit.status !== "generated") {
      await updateKitStatus(id, "retrieving");
      try {
        preRetrieved = await runRetrieval({ company_url: kit.input.company_url });
      } catch (err) {
        await persistFailedKit(id, err instanceof Error ? err.message : String(err));
        throw err;
      }
      const content = withSource(kit.content, preRetrieved, kit.input.jd, kit.input.company_url);
      await persistRetrieval(id, content);
      await recordSourceFailures(req.user!._id, id, preRetrieved.failures);
    }

    try {
      const content = await runPipeline(
        { jd: kit.input.jd, company_url: kit.input.company_url, days: kit.input.days },
        undefined,
        preRetrieved,
      );
      await persistGeneratedKit(id, content);
      // kit comes from findKitById() which already returns a lean plain object
      // (same as the retrieve route) — never .toObject() here.
      res.json({ kit: { ...kit, status: "generated", content } });
    } catch (err) {
      await persistFailedKit(id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }),
);
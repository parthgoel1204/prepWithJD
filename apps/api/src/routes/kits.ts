import { Router, type Request, type Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import {
  runRetrieval,
  createKit,
  listKits,
  findKitById,
  updateKitStatus,
  persistRetrieval,
  persistFailedKit,
  recordSourceFailures,
  listSourceFailures,
  deleteKit,
  resolveRetrievalOptions,
} from "@prepwithjd/pipeline";
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

    const content = {
      ...kit.content,
      source: {
        ...kit.content.source,
        company: result.company || kit.content.source.company,
        company_url: kit.input.company_url,
        jd_chars: kit.input.jd.length,
        researched_at: new Date().toISOString(),
        pages_used: result.pages_used,
        // Persist each search-API discussion hit alongside pages_used (extended field).
        discussion: result.search_hits.items.map((i) => ({
          title: i.title,
          url: i.url,
          snippet: i.snippet,
        })),
        // Persist which URLs robots.txt excluded (proves the rule did the work, not luck).
        robots_blocked: result.robots_blocked.map((b) => ({ url: b.url, via: b.via, rule: b.rule })),
      },
    };

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
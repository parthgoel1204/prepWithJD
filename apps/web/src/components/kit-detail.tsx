"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "@/lib/api";

interface KitFull {
  _id: string;
  status: string;
  input: { jd: string; company_url: string; days: number; file_name?: string };
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

interface RetrievalFailure {
  source_url: string;
  stage: string;
  code: string;
  message: string;
  occurred_at?: string;
}

interface RetrievalResultResponse {
  kit: KitFull;
  retrieval: {
    pages_used: string[];
    pages: Array<{ url: string; title: string; depth: number }>;
    search_hits: SearchHit[];
    robots_blocked: Array<{ url: string; via: string; rule: string }>;
    failures: RetrievalFailure[];
  };
}

// Pipeline output (the generated KitContent) rendered by the Day-2 Generate action.
interface PipelineContent {
  role?: { title: string; seniority: string; responsibilities: string[]; requirements: Array<{ id: string; text: string; kind: string; priority: string }> };
  questions?: Array<{ id: string; requirement_ids: string[]; category: string; prompt: string; answer_outline: string; difficulty: number }>;
  flashcards?: Array<{ id: string; front: string; back: string; requirement_ids: string[] }>;
  schedule?: { days_available: number; days: Array<{ day: number; focus: string; question_ids: string[]; minutes: number }> };
  coverage?: { uncovered_requirement_ids: string[]; passes: number };
  stage_errors?: Array<{ stage: string; code: string; message: string; occurred_at: string }>;
}

type LoadState = "loading" | "loaded" | "error";

const CATEGORY_LABELS: Record<string, string> = {
  technical: "Technical deep-dive",
  behavioural: "Behavioural",
  "system-design": "System design",
  "company-fit": "Company fit",
};

const PRIORITY_STYLES: Record<string, string> = {
  must: "bg-rose-100 text-rose-700",
  nice: "bg-amber-100 text-amber-700",
};

export default function KitDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [kit, setKit] = useState<KitFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalResultResponse["retrieval"] | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);

  const [generating, setGenerating] = useState<"idle" | "retrieving" | "generating">("idle");
  const [generateError, setGenerateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setError(null);
    try {
      const res = await apiFetch<{ kit: KitFull }>(`/api/kits/${id}`);
      setKit(res.kit);
      setLoadState("loaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load kit");
      setLoadState("error");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    if (id) void load();
  }, [id, load]);

  const runRetrieval = async () => {
    setRetrieving(true);
    setRetrievalError(null);
    try {
      const res = await apiFetch<RetrievalResultResponse>(`/api/kits/${id}/retrieve`, { method: "POST" });
      setRetrieval(res.retrieval);
      setKit(res.kit);
    } catch (err) {
      setRetrievalError(err instanceof Error ? err.message : "Retrieval failed");
    } finally {
      setRetrieving(false);
    }
  };

  const runGenerate = async () => {
    setGenerateError(null);
    if (!kit) return;
    const status = kit.status;

    // One click, one flow: for a draft/failed/retrying kit, chain the retrieval
    // stage first (distinct "Retrieving…" state), then generation. When already
    // retrieved/generated we go straight to "Generating…". Stages stay separate.
    if (status !== "retrieved" && status !== "generated") {
      setGenerating("retrieving");
      try {
        const r = await apiFetch<RetrievalResultResponse>(`/api/kits/${id}/retrieve`, { method: "POST" });
        setKit(r.kit);
        setRetrieval(r.retrieval);
      } catch (err) {
        setGenerateError(err instanceof Error ? err.message : "Retrieval stage failed");
        setGenerating("idle");
        return;
      }
    }

    setGenerating("generating");
    try {
      const res = await apiFetch<{ kit: KitFull }>(`/api/kits/${id}/generate`, { method: "POST" });
      setKit(res.kit);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating("idle");
    }
  };

  if (loadState === "loading") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-sm text-slate-500">Loading kit…</p>
      </main>
    );
  }

  if (loadState === "error" || !kit) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
        <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const content = kit.content as PipelineContent;
  const generated = kit.status === "generated";
  const reqs = content.role?.requirements ?? [];
  const questions = content.questions ?? [];
  const catCount = new Set(questions.map((q) => q.category)).size;
  const schedule = content.schedule?.days ?? [];
  const scheduleDays = content.schedule?.days_available ?? 0;
  const flashes = content.flashcards ?? [];
  const coverage = content.coverage;
  const stageErrors = content.stage_errors ?? [];

  const noScheduleMaterial = questions.length === 0 || schedule.every((d) => d.minutes === 0);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/dashboard" className="text-sm font-medium text-indigo-600 hover:underline">
        ← Dashboard
      </Link>

      <header className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Kit detail</h1>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            kit.status === "generated"
              ? "bg-emerald-100 text-emerald-700"
              : kit.status === "retrieved"
                ? "bg-sky-100 text-sky-700"
                : "bg-slate-100 text-slate-600"
          }`}
        >
          {kit.status}
        </span>
      </header>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Company URL</dt>
            <dd className="font-medium text-slate-800">{kit.input.company_url}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Prep days</dt>
            <dd className="font-medium text-slate-800">{kit.input.days}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Created</dt>
            <dd className="font-medium text-slate-800">{new Date(kit.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-slate-500">JD length</dt>
            <dd className="font-medium text-slate-800">{kit.input.jd.length.toLocaleString()} chars</dd>
          </div>
        </dl>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">Show job description</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
            {kit.input.jd}
          </pre>
        </details>
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">Research (Day 1)</h2>
        <p className="mt-1 text-sm text-slate-500">
          Crawls the company home page, ranks internal links (careers/culture/blog), respects robots.txt, and uses Tavily
          to find interview-process discussion.
        </p>
        <button
          onClick={() => void runRetrieval()}
          disabled={retrieving}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {retrieving ? "Crawling… (timeouts/retries run in the background)" : "Run retrieval"}
        </button>

        {retrievalError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {retrievalError}
          </div>
        )}

        {retrieval && (
          <div className="mt-5 space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">Pages used ({retrieval.pages_used.length})</h3>
              <ul className="mt-2 space-y-1">
                {retrieval.pages.map((p, i) => (
                  <li key={`${p.url}-${i}`} className="truncate text-sm text-slate-600">
                    <span className="mr-2 inline-block w-6 text-right text-xs text-slate-400">{i + 1}</span>
                    <span className="font-medium text-slate-800">{p.title || "(untitled)"}</span>{" "}
                    <span className="text-slate-400">· d{p.depth}</span> — <span className="text-xs">{p.url}</span>
                  </li>
                ))}
              </ul>
            </div>

            {retrieval.search_hits.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Interview-process discussion (Tavily) — {retrieval.search_hits.length} results</h3>
                <ul className="mt-2 space-y-1.5">
                  {retrieval.search_hits.map((s, i) => (
                    <li key={`${s.url}-${i}`} className="text-sm">
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-indigo-600 hover:underline">
                        {s.title}
                      </a>
                      {s.snippet && <p className="text-xs text-slate-500">{s.snippet}</p>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {retrieval.robots_blocked.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700">
                  robots.txt-blocked pages{" "}
                  <span className="font-normal text-slate-500">({retrieval.robots_blocked.length} — skipped by this rule, not by accident)</span>
                </h3>
                <ul className="mt-2 space-y-1">
                  {retrieval.robots_blocked.map((b) => (
                    <li key={`${b.url}-${b.rule}`} className="truncate text-xs text-slate-600">
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">{b.rule}</span>{" "}
                      <span className="font-mono">{b.url}</span>
                      <span className="text-slate-400"> (linked from {b.via})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Source failures logged{" "}
                <span className="font-normal text-slate-500">({retrieval.failures.length} — crawl continues past these)</span>
              </h3>
              {retrieval.failures.length === 0 ? (
                <p className="mt-2 text-sm text-emerald-700">No failures this run — clean crawl.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {retrieval.failures.map((f, i) => (
                    <li key={`${f.source_url}-${i}`} className="truncate text-xs text-slate-600">
                      <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-600">{f.code}</span>{" "}
                      [{f.stage}] <span className="font-mono">{f.source_url}</span> — {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">Pipeline (Day 2)</h2>
        <p className="mt-1 text-sm text-slate-500">
          One-click flow: for a draft kit, auto-runs retrieval first, then requirement extraction → per-category question
          generation → coverage loop → schedule → validation (LLM calls take ~1–2 minutes).
        </p>
        <button
          onClick={() => void runGenerate()}
          disabled={generating !== "idle"}
          className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {generating === "retrieving"
            ? "Retrieving… (crawl + search)"
            : generating === "generating"
              ? "Generating… (extraction + 4 category LLM calls)"
              : kit.status === "generated"
                ? "Regenerate kit"
                : kit.status === "retrieved"
                  ? "Generate kit"
                  : "Generate kit (auto-retrieves first)"}
        </button>

        {generateError && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {generateError}
          </div>
        )}

        {generated && (
          <div className="mt-6 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Requirements — {reqs.length} extracted
              </h3>
              <ul className="mt-2 grid grid-cols-1 gap-2">
                {reqs.map((r) => (
                  <li key={r.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                    <span className="mr-2 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{r.id}</span>
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[r.priority] ?? "bg-slate-100 text-slate-600"}`}>
                      {r.priority}
                    </span>
                    <span className="text-slate-800">{r.text}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Questions — {questions.length} across {catCount} categories
              </h3>
              <ul className="mt-2 space-y-3">
                {questions.map((q) => (
                  <li key={q.id} className="rounded-lg border border-slate-100 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-[10px] text-slate-400">{q.id}</span>
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                        {CATEGORY_LABELS[q.category] ?? q.category}
                      </span>
                      <span className="text-xs text-amber-600">{"★".repeat(Math.max(0, Math.min(3, q.difficulty)))}{"☆".repeat(Math.max(0, 3 - Math.min(3, q.difficulty)))}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-400">{q.requirement_ids.join(", ")}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-800">{q.prompt}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-medium text-slate-500">Answer outline</summary>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{q.answer_outline}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Flashcards — {flashes.length} cards
              </h3>
              <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {flashes.map((f) => (
                  <li key={f.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-[10px] text-slate-400">{f.id}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-400">{f.requirement_ids.join(", ")}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium text-slate-800">{f.front}</p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-medium text-slate-500">Reveal answer</summary>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">{f.back}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </div>

            {noScheduleMaterial && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                This job description didn't contain enough detail to generate a study plan.
              </p>
            )}

            <div>
              <h3 className="text-sm font-semibold text-slate-700">
                Schedule — {scheduleDays} days planned
              </h3>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {schedule.map((d) => {
                  const isEmpty = d.minutes === 0 || d.question_ids.length === 0;
                  return (
                    <div
                      key={d.day}
                      className={
                        isEmpty
                          ? "rounded-lg border border-dashed border-slate-200 bg-white p-2.5 text-xs"
                          : "rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-xs"
                      }
                    >
                      <div className="font-semibold text-slate-700">
                        Day {d.day}
                        {!isEmpty && <span className="text-slate-400"> · {d.minutes} min</span>}
                      </div>
                      {isEmpty ? (
                        <div className="italic text-slate-400">Review day — no new material scheduled</div>
                      ) : (
                        <>
                          <div className="text-slate-500">{d.focus}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-slate-400">{d.question_ids.join(", ")}</div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {coverage && coverage.uncovered_requirement_ids.length > 0 && (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700">
                  Coverage left uncovered (honest): {coverage.uncovered_requirement_ids.join(", ")} after {coverage.passes} pass(es)
                </p>
              )}
            </div>

            {stageErrors.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Stage degradations (log-and-continue)</h3>
                <ul className="mt-2 space-y-1">
                  {stageErrors.map((e, i) => (
                    <li key={`${e.stage}-${i}`} className="truncate text-xs text-slate-600">
                      <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-600">{e.code}</span> [{e.stage}] {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="mt-1 text-sm text-slate-500">Raw model as persisted in MongoDB — confirms the save path and output contract fields.</p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(kit, null, 2)}
        </pre>
      </section>
    </main>
  );
}
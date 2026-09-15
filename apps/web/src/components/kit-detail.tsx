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

interface PracticeEntryUI {
  cardId: string;
  confidence: "low" | "medium" | "high";
  lastSeenAt: string;
}

// Pipeline output (the generated KitContent) rendered by the Day-2 Generate action.
interface PipelineContent {
  company_brief?: { summary: string; what_they_do: string; sources: string[] };
  role?: { title: string; seniority: string; responsibilities: string[]; requirements: Array<{ id: string; text: string; kind: string; priority: string }> };
  questions?: Array<{ id: string; requirement_ids: string[]; category: string; prompt: string; answer_outline: string; difficulty: number }>;
  flashcards?: Array<{ id: string; front: string; back: string; requirement_ids: string[] }>;
  schedule?: { days_available: number; days: Array<{ day: number; focus: string; question_ids: string[]; minutes: number }> };
  coverage?: { uncovered_requirement_ids: string[]; passes: number };
  stage_errors?: Array<{ stage: string; code: string; message: string; occurred_at: string }>;
  practice?: PracticeEntryUI[];
}

type TabKey = "overview" | "requirements" | "questions" | "flashcards" | "practice" | "schedule";

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

const CONFIDENCE_STYLES: Record<"low" | "medium" | "high", string> = {
  low: "rounded-md bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-100",
  medium: "rounded-md bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-100",
  high: "rounded-md bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-100",
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "requirements", label: "Requirements" },
  { key: "questions", label: "Questions" },
  { key: "flashcards", label: "Flashcards" },
  { key: "practice", label: "Practice" },
  { key: "schedule", label: "Schedule" },
];

/** Click-to-edit text area — edits in place, saves on blur or Enter (Shift+Enter = newline). */
function InlineEdit({
  value,
  onSave,
  label,
  textClass,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
  label: string;
  textClass?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const begin = () => {
    setDraft(value);
    setFailed(false);
    setEditing(true);
  };

  const save = async () => {
    if (draft !== value) {
      setSaving(true);
      setFailed(false);
      try {
        await onSave(draft);
        setEditing(false);
      } catch (err) {
        setFailed(true);
      } finally {
        setSaving(false);
      }
    } else {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="w-full">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
          disabled={saving}
          aria-label={`Edit ${label}`}
          className="w-full rounded-md border border-violet-300 bg-white px-2 py-1 text-sm text-slate-800 outline-none ring-1 ring-violet-100"
          rows={3}
        />
        {failed && <p className="mt-1 text-xs text-red-600">Save failed — try again.</p>}
      </div>
    );
  }

  return (
    <button type="button" onClick={begin} title={`Click to edit ${label}`} className="group block w-full text-left">
      <span className={textClass ?? "text-sm text-slate-800"}>
        {value ? (
          value
        ) : (
          <span className="italic text-slate-400">Click to add {label}</span>
        )}
      </span>
      <span className="ml-1 text-xs text-slate-300 group-hover:text-violet-500">✎</span>
    </button>
  );
}

/** Small inline "add by hand" form. Scope: questions (category/prompt/outline) + flashcards (front/back). */
function AddItemForm({
  kind,
  onAdd,
}: {
  kind: "question" | "flashcard";
  onAdd: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const isQuestion = kind === "question";
  const [category, setCategory] = useState(isQuestion ? "technical" : "");
  const [prompt, setPrompt] = useState("");
  const [outline, setOutline] = useState("");
  const [front, setFront] = useState("");
  const [back, setBack] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = isQuestion
      ? { op: "add-question", category, prompt: prompt.trim(), answer_outline: outline.trim() }
      : { op: "add-flashcard", front: front.trim(), back: back.trim() };
    setSaving(true);
    setError(null);
    try {
      await onAdd(payload);
      if (isQuestion) {
        setPrompt("");
        setOutline("");
      } else {
        setFront("");
        setBack("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-semibold text-slate-600">Add {kind} by hand</p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        {isQuestion && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm"
          >
            {Object.keys(CATEGORY_LABELS).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        )}
        <input
          value={isQuestion ? prompt : front}
          onChange={(e) => (isQuestion ? setPrompt(e.target.value) : setFront(e.target.value))}
          placeholder={isQuestion ? "Question prompt" : "Card front"}
          maxLength={isQuestion ? 10_000 : 1_000}
          className="w-full flex-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-sm sm:w-64"
        />
        <button
          type="submit"
          disabled={saving || (isQuestion ? !prompt.trim() : !front.trim())}
          className="rounded-md bg-violet-700 px-3 py-1 text-sm font-medium text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
      <textarea
        value={isQuestion ? outline : back}
        onChange={(e) => (isQuestion ? setOutline(e.target.value) : setBack(e.target.value))}
        placeholder={isQuestion ? "Answer outline (optional)" : "Card back"}
        maxLength={isQuestion ? 20_000 : 5_000}
        className="mt-2 w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm"
        rows={2}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </form>
  );
}

/** Confirmation dialog for deletions (scoped to this pass's delete flow). */
function ConfirmDeleteDialog({
  label,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  label: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-lg">
        <h3 className="text-sm font-semibold text-slate-800">Delete this {label}?</h3>
        <p className="mt-1 text-sm text-slate-500">This removes it permanently from the kit. There's no undo.</p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function KitDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [kit, setKit] = useState<KitFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");

  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalResultResponse["retrieval"] | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);

  const [generating, setGenerating] = useState<"idle" | "retrieving" | "generating">("idle");
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<{ target: "questions" | "flashcards"; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [practiceCursor, setPracticeCursor] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [lowestFirst, setLowestFirst] = useState(false);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await patchContent({ op: "remove-item", target: pendingDelete.target, id: pendingDelete.id });
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

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

  const [patchBusy, setPatchBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);

  const regenerate = async (op: Record<string, unknown>, label: string) => {
    setRegenBusy(label);
    setRegenError(null);
    try {
      await patchContent(op);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setRegenBusy(null);
    }
  };

  const patchContent = useCallback(
    async (op: unknown): Promise<void> => {
      setPatchBusy(true);
      try {
        const res = await apiFetch<{ kit: KitFull }>(`/api/kits/${id}/content`, {
          method: "PATCH",
          body: JSON.stringify(op),
        });
        setKit(res.kit);
      } finally {
        setPatchBusy(false);
      }
    },
    [id],
  );

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
  const brief = content.company_brief;
  const reqs = content.role?.requirements ?? [];
  const questions = content.questions ?? [];
  const catCount = new Set(questions.map((q) => q.category)).size;
  const schedule = content.schedule?.days ?? [];
  const scheduleDays = content.schedule?.days_available ?? 0;
  const flashes = content.flashcards ?? [];
  const coverage = content.coverage;
  const stageErrors = content.stage_errors ?? [];

  const noScheduleMaterial = questions.length === 0 || schedule.every((d) => d.minutes === 0);

  const practiceEntries = content.practice ?? [];
  const practiceMap = new Map(practiceEntries.map((e) => [e.cardId, e]));
  const rankOf = (f: NonNullable<PipelineContent["flashcards"]>[number]) => {
    const e = practiceMap.get(f.id);
    return e ? (e.confidence === "low" ? 1 : e.confidence === "medium" ? 2 : 3) : 0;
  };
  const deck = (() => {
    if (!lowestFirst) return flashes;
    return [...flashes].sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  })();
  const activeIndex = practiceCursor ? Math.max(0, deck.findIndex((f) => f.id === practiceCursor)) : 0;
  const current = deck.length ? deck[activeIndex] : undefined;
  const reviewedCount = practiceEntries.filter((e) => flashes.some((f) => f.id === e.cardId)).length;

  const answerCard = async (confidence: "low" | "medium" | "high") => {
    if (!current) return;
    await patchContent({ op: "practice", card_id: current.id, confidence });
    setRevealed(false);
    const next = deck[activeIndex + 1];
    setPracticeCursor(next ? next.id : "__done__");
  };

  const toggleLowestFirst = () => {
    setLowestFirst((v) => !v);
    setPracticeCursor(null);
    setRevealed(false);
  };

  const activeIndexText = practiceCursor === "__done__" ? -1 : activeIndex;

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

      <nav className="mt-4 flex flex-wrap gap-1 border-b border-slate-200" aria-label="Kit sections">
        {TABS.map((t) => {
          const count =
            t.key === "requirements"
              ? reqs.length
              : t.key === "questions"
                ? questions.length
                : t.key === "flashcards"
                  ? flashes.length
                  : t.key === "schedule"
                    ? scheduleDays
                    : undefined;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                active
                  ? "border-violet-700 text-violet-900"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {t.label}
              {typeof count === "number" && (
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    active ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && (
        <>
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
            <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Research (Day 1)</h2>
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
                      <li key={`${p.url}-${i}`} className="truncate rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600">
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
                        <li key={`${b.url}-${b.rule}`} className="truncate rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
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
                        <li key={`${f.source_url}-${i}`} className="truncate rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600">
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
            <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Pipeline (Day 2)</h2>
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

            {regenError && (
              <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {regenError}
              </div>
            )}

            {generated && brief && (
              <div className="mt-6 space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700">Company brief</h3>
                  <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
                    <div className="text-xs font-medium text-slate-500">Summary</div>
                    <InlineEdit
                      value={brief.summary}
                      onSave={(v) => patchContent({ op: "update-brief", field: "summary", value: v })}
                      label="company brief summary"
                      textClass="mt-1 text-sm text-slate-800"
                    />
                    {brief.what_they_do && (
                      <>
                        <div className="mt-3 text-xs font-medium text-slate-500">What they do</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{brief.what_they_do}</p>
                      </>
                    )}
                    {brief.sources.length > 0 && (
                      <div className="mt-3 text-xs text-slate-500">
                        Sources: <span className="font-mono">{brief.sources.join(", ")}</span>
                      </div>
                    )}
                    <button
                      onClick={() => void regenerate({ op: "regenerate-brief" }, "brief")}
                      disabled={regenBusy !== null}
                      className="mt-3 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {regenBusy === "brief" ? "Regenerating brief…" : "Regenerate brief"}
                    </button>
                  </div>
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
        </>
      )}

      {tab === "requirements" && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Requirements — {reqs.length} extracted</h2>
          {generated ? (
            <ul className="mt-2 grid grid-cols-1 gap-2">
              {reqs.map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                  <span className="mr-2 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{r.id}</span>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[r.priority] ?? "bg-slate-100 text-slate-600"}`}>
                    {r.priority}
                  </span>
                  <span className="text-slate-800">{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Run Generate in Overview to extract requirements from the job description.</p>
          )}
        </section>
      )}

      {tab === "questions" && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">
            Questions — {questions.length} across {catCount} categories
          </h2>
          {generated ? (
            <>
              <AddItemForm kind="question" onAdd={(payload) => patchContent(payload)} />

              {(() => {
                const move = async (category: string, id: string, dir: -1 | 1) => {
                  const items = questions.filter((q) => q.category === category);
                  const idx = items.findIndex((q) => q.id === id);
                  const swap = idx + dir;
                  if (idx < 0 || swap < 0 || swap >= items.length) return;
                  const next = [...items];
                  [next[idx], next[swap]] = [next[swap], next[idx]];
                  await patchContent({ op: "reorder-questions", category, ordered_ids: next.map((q) => q.id) });
                };
                const cats = [...new Set(questions.map((q) => q.category))];
                return cats.map((category) => {
                  const items = questions.filter((q) => q.category === category);
                  return (
                    <div key={category} className="mt-4">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {CATEGORY_LABELS[category] ?? category} <span className="text-slate-400">· {items.length}</span>
                      </h4>
                      <button
                        onClick={() => void regenerate({ op: "regenerate-category", category }, `category:${category}`)}
                        disabled={regenBusy !== null}
                        className="mt-1 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {regenBusy === `category:${category}` ? `Regenerating ${CATEGORY_LABELS[category] ?? category}…` : "Regenerate category"}
                      </button>
                      <ul className="mt-2 space-y-2">
                        {items.map((q, i) => (
                          <li key={q.id} className="rounded-lg border border-slate-200 bg-white p-3">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <span className="flex overflow-hidden rounded border border-slate-200">
                                <button
                                  onClick={() => void move(category, q.id, -1)}
                                  disabled={patchBusy || i === 0}
                                  aria-label="Move question up"
                                  className="px-1.5 text-xs text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                                >
                                  ↑
                                </button>
                                <button
                                  onClick={() => void move(category, q.id, 1)}
                                  disabled={patchBusy || i === items.length - 1}
                                  aria-label="Move question down"
                                  className="border-l border-slate-200 px-1.5 text-xs text-slate-500 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                                >
                                  ↓
                                </button>
                              </span>
                              <span className="font-mono text-[10px] text-slate-400">{q.id}</span>
                              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                                {CATEGORY_LABELS[q.category] ?? q.category}
                              </span>
                              <span className="text-xs text-amber-600">{"★".repeat(Math.max(0, Math.min(3, q.difficulty)))}{"☆".repeat(Math.max(0, 3 - Math.min(3, q.difficulty)))}</span>
                              <span className="ml-auto font-mono text-[10px] text-slate-400">{q.requirement_ids.join(", ")}</span>
                              <button
                                onClick={() => setPendingDelete({ target: "questions", id: q.id, label: "question" })}
                                className="text-xs font-medium text-red-500 transition hover:text-red-700"
                              >
                                Delete
                              </button>
                            </div>
                            <div className="mt-1">
                              <InlineEdit
                                value={q.prompt}
                                onSave={(v) => patchContent({ op: "update-item", target: "questions", id: q.id, field: "prompt", value: v })}
                                label="question prompt"
                              />
                            </div>
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs font-medium text-violet-700 transition hover:text-violet-900">Answer outline</summary>
                              <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
                                <InlineEdit
                                  value={q.answer_outline}
                                  onSave={(v) => patchContent({ op: "update-item", target: "questions", id: q.id, field: "answer_outline", value: v })}
                                  label="answer outline"
                                  textClass="text-xs text-slate-600"
                                />
                              </div>
                            </details>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                });
              })()}
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Run Generate in Overview to create questions.</p>
          )}
        </section>
      )}

      {tab === "flashcards" && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Flashcards — {flashes.length} cards</h2>
          {generated ? (
            <>
              <AddItemForm kind="flashcard" onAdd={(payload) => patchContent(payload)} />
              <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {flashes.map((f) => (
                  <li key={f.id} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-[10px] text-slate-400">{f.id}</span>
                      <span className="ml-auto font-mono text-[10px] text-slate-400">{f.requirement_ids.join(", ")}</span>
                      <button
                        onClick={() => setPendingDelete({ target: "flashcards", id: f.id, label: "flashcard" })}
                        className="text-xs font-medium text-red-500 transition hover:text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                    <div className="mt-1 text-sm font-medium text-slate-800">
                      <InlineEdit
                        value={f.front}
                        onSave={(v) => patchContent({ op: "update-item", target: "flashcards", id: f.id, field: "front", value: v })}
                        label="flashcard front"
                        textClass="text-sm font-medium text-slate-800"
                      />
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-medium text-violet-700 transition hover:text-violet-900">Reveal answer</summary>
                      <div className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
                        <InlineEdit
                          value={f.back}
                          onSave={(v) => patchContent({ op: "update-item", target: "flashcards", id: f.id, field: "back", value: v })}
                          label="flashcard back"
                          textClass="text-xs text-slate-600"
                        />
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Run Generate in Overview to create flashcards.</p>
          )}
        </section>
      )}

      {tab === "practice" && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Practice</h2>
            <button
              onClick={toggleLowestFirst}
              className="rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
              aria-pressed={lowestFirst}
            >
              {lowestFirst ? "Reviewing lowest confidence first" : "Review in deck order"}
            </button>
          </div>

          {flashes.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No flashcards yet — run Generate in Overview to create a deck.</p>
          ) : practiceCursor === "__done__" ? (
            <p className="mt-4 text-sm text-emerald-700">Deck complete — all {flashes.length} cards reviewed.</p>
          ) : current ? (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>
                  {reviewedCount} of {flashes.length} reviewed
                </span>
                <span>
                  Card {activeIndexText + 1} of {deck.length}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-violet-600 transition-all"
                  style={{ width: `${Math.round((reviewedCount / flashes.length) * 100)}%` }}
                />
              </div>
              <div className="mt-4 rounded-lg border border-slate-200 p-6">
                <p className="text-center text-xs font-medium text-slate-400">Front</p>
                <p className="mt-2 text-center text-lg font-medium text-slate-800">{current.front}</p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {revealed ? (
                    <>
                      <div className="w-full rounded-md bg-slate-50 p-4">
                        <p className="text-xs font-medium text-slate-400">Back</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{current.back}</p>
                      </div>
                      <div className="flex gap-2">
                        {(["low", "medium", "high"] as const).map((c) => (
                          <button key={c} onClick={() => void answerCard(c)} className={CONFIDENCE_STYLES[c]}>
                            {c === "low" ? "Low" : c === "medium" ? "Medium" : "High"}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={() => setRevealed(true)}
                      className="rounded-md bg-violet-700 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-800"
                    >
                      Reveal answer
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {tab === "schedule" && (
        <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="border-l-2 border-violet-500 pl-2.5 text-base font-semibold text-slate-800">Schedule — {scheduleDays} days planned</h2>
          {generated ? (
            <>
              {noScheduleMaterial && (
                <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  This job description didn't contain enough detail to generate a study plan.
                </p>
              )}
              <button
                onClick={() => void regenerate({ op: "regenerate-schedule" }, "schedule")}
                disabled={regenBusy !== null}
                className="mt-2 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {regenBusy === "schedule" ? "Regenerating schedule…" : "Regenerate schedule"}
              </button>
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
            </>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Run Generate in Overview to create a study plan.</p>
          )}
        </section>
      )}

      <details className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <summary className="cursor-pointer select-none text-sm font-medium text-slate-500 transition hover:text-slate-800">
          <span className="inline-flex items-center gap-2">
            <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] text-violet-700">json</span>
            Developer view
          </span>
        </summary>
        <p className="mt-2 text-xs text-slate-500">Raw model as persisted in MongoDB — confirms the save path and output contract fields.</p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(kit, null, 2)}
        </pre>
      </details>

      {pendingDelete && (
        <ConfirmDeleteDialog
          label={pendingDelete.label}
          busy={deleting}
          error={deleteError}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </main>
  );
}
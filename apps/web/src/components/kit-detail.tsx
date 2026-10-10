"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { GenerationProgress } from "@/components/generation-progress";
import { TransitionPanel } from "@/components/core/transition-panel";
import { InView } from "@/components/core/in-view";

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

// Mirrors packages/pipeline scheduling (1=10, 2=15, 3=20 minutes); the web app must not import the pipeline.
const QUESTION_MINUTES: Record<number, number> = { 1: 10, 2: 15, 3: 20 };
const minutesForDifficulty = (difficulty: number): number =>
  QUESTION_MINUTES[Math.min(3, Math.max(1, Math.round(difficulty)))] ?? 15;

const DIFFICULTY_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: "Easy", className: "bg-emerald-50 text-emerald-700" },
  2: { label: "Medium", className: "bg-amber-50 text-amber-700" },
  3: { label: "Hard", className: "bg-red-50 text-red-700" },
};

type QuestionSort = "schedule" | "difficulty" | "confidence";

const CONFIDENCE_STYLES: Record<"low" | "medium" | "high", string> = {
  low: "text-rose-700 hover:bg-rose-50",
  medium: "text-amber-700 hover:bg-amber-50",
  high: "text-emerald-700 hover:bg-emerald-50",
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
      } catch {
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
          className="w-full rounded-lg border border-zinc-950/15 bg-white px-2 py-1 text-sm text-zinc-900 outline-none ring-2 ring-violet-600/20 focus:border-violet-600"
          rows={3}
        />
        {failed && <p className="mt-1 text-xs text-red-600">Save failed — try again.</p>}
      </div>
    );
  }

  return (
    <button type="button" onClick={begin} title={`Click to edit ${label}`} className="group block w-full text-left">
      <span className={textClass ?? "text-sm text-zinc-900"}>
        {value ? (
          value
        ) : (
          <span className="italic text-zinc-400">Click to add {label}</span>
        )}
      </span>
      <span className="ml-1 text-xs text-zinc-300 group-hover:text-violet-500">✎</span>
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
  const [open, setOpen] = useState(false);
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
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98]"
      >
        Add {kind}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-950/10 bg-zinc-100 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Add {kind} by hand</p>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        {isQuestion && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-zinc-950/10 bg-white px-2 py-1.5 text-sm text-zinc-800 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
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
          className="w-full flex-1 rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20 sm:w-64"
        />
        <button
          type="submit"
          disabled={saving || (isQuestion ? !prompt.trim() : !front.trim())}
          className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-800 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 active:scale-[0.98]"
        >
          Cancel
        </button>
      </div>
      <textarea
        value={isQuestion ? outline : back}
        onChange={(e) => (isQuestion ? setOutline(e.target.value) : setBack(e.target.value))}
        placeholder={isQuestion ? "Answer outline (optional)" : "Card back"}
        maxLength={isQuestion ? 20_000 : 5_000}
        className="mt-2 w-full rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-lg border border-zinc-950/10 bg-white p-5 shadow-lg">
        <h3 className="text-sm font-semibold text-zinc-900">Delete this {label}?</h3>
        <p className="mt-1 text-sm text-zinc-500">This removes it permanently from the kit. There&apos;s no undo.</p>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-700 active:scale-[0.98] disabled:opacity-50"
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
  const reduceMotion = useReducedMotion();
  const [qCategory, setQCategory] = useState<string>("all");
  const [qText, setQText] = useState("");
  const [qSort, setQSort] = useState<QuestionSort>("schedule");
  const [expandedQ, setExpandedQ] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState(0);
  const [fRevealed, setFRevealed] = useState(false);

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
  const [practiceError, setPracticeError] = useState<string | null>(null);

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
      <main className="mx-auto max-w-4xl px-4 py-8 md:px-8" aria-busy>
        <div className="h-9 w-64 animate-pulse rounded-lg bg-zinc-200" aria-hidden />
        <div className="mt-3 h-4 w-96 max-w-full animate-pulse rounded bg-zinc-100" aria-hidden />
        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl border border-zinc-950/10 bg-zinc-100" />
          ))}
        </div>
        <div className="mt-8 space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-zinc-950/10 bg-zinc-100" />
          ))}
        </div>
        <span className="sr-only">Loading kit…</span>
      </main>
    );
  }

  if (loadState === "error" || !kit) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
        <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-zinc-700 hover:text-zinc-900 hover:underline">
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

  const answerCard = (confidence: "low" | "medium" | "high") => {
    if (!current) return;
    const cardId = current.id;
    const next = deck[activeIndex + 1];

    setKit((prev) => {
      if (!prev) return prev;
      const prevContent = prev.content as PipelineContent;
      const entries = prevContent.practice ?? [];
      const existing = entries.find((e) => e.cardId === cardId);
      const lastSeenAt = new Date().toISOString();
      const practice = existing
        ? entries.map((e) => (e.cardId === cardId ? { ...e, confidence, lastSeenAt } : e))
        : [...entries, { cardId, confidence, lastSeenAt }];
      return { ...prev, content: { ...prevContent, practice } };
    });

    setRevealed(false);
    setPracticeError(null);
    setPracticeCursor(next ? next.id : "__done__");

    void patchContent({ op: "practice", card_id: cardId, confidence }).catch((err) => {
      setPracticeError(err instanceof Error ? err.message : "Could not save your confidence rating");
    });
  };

  const toggleLowestFirst = () => {
    setLowestFirst((v) => !v);
    setPracticeCursor(null);
    setRevealed(false);
    setPracticeError(null);
  };

  const activeIndexText = practiceCursor === "__done__" ? -1 : activeIndex;

  const activeFlashIdx = Math.min(flashIdx, Math.max(0, flashes.length - 1));
  const goFlash = (dir: -1 | 1) => {
    setFlashIdx((i) => Math.min(Math.max(i + dir, 0), Math.max(0, flashes.length - 1)));
    setFRevealed(false);
  };

  const companyHost = (() => {
    try {
      return new URL(kit.input.company_url).hostname.replace(/^www\./, "");
    } catch {
      return kit.input.company_url;
    }
  })();
  const kitTitle = content.role?.title
    ? `${content.role.title} at ${companyHost}`
    : companyHost;

  const stats: Array<{ eyebrow: string; value: string }> = [
    { eyebrow: "Questions", value: String(questions.length) },
    { eyebrow: "Flashcards", value: String(flashes.length) },
    { eyebrow: "Days", value: String(scheduleDays) },
    { eyebrow: "Requirements", value: String(reqs.length) },
  ];

  const questionPracticed = (q: (typeof questions)[number]): boolean =>
    flashes.some((f) => f.requirement_ids.some((r) => q.requirement_ids.includes(r)) && practiceMap.has(f.id));

  const questionRank = (q: (typeof questions)[number]): number => {
    const ranks = flashes
      .filter((f) => f.requirement_ids.some((r) => q.requirement_ids.includes(r)))
      .map((f) => rankOf(f))
      .filter((r) => r > 0);
    return ranks.length ? Math.min(...ranks) : 0;
  };

  const categoryCounts = new Map<string, number>();
  for (const q of questions) categoryCounts.set(q.category, (categoryCounts.get(q.category) ?? 0) + 1);

  const normalizedQuery = qText.trim().toLowerCase();
  const visibleGroups = [...new Set(questions.map((q) => q.category))]
    .filter((c) => qCategory === "all" || c === qCategory)
    .map((category) => {
      let items = questions.filter((q) => q.category === category);
      if (normalizedQuery) items = items.filter((q) => q.prompt.toLowerCase().includes(normalizedQuery));
      if (qSort === "difficulty") items = [...items].sort((a, b) => a.difficulty - b.difficulty);
      else if (qSort === "confidence") items = [...items].sort((a, b) => questionRank(a) - questionRank(b));
      return { category, items };
    })
    .filter((g) => g.items.length > 0);

  const nextCard = (() => {
    if (!flashes.length) return undefined;
    const unreviewed = flashes.find((f) => !practiceMap.has(f.id));
    if (unreviewed) return unreviewed;
    return [...flashes].sort((a, b) => rankOf(a) - rankOf(b) || (a.id < b.id ? -1 : 1))[0];
  })();

  const coverageStats = (() => {
    if (!coverage || !reqs.length) return null;
    return [...new Set(reqs.map((r) => r.priority))].map((priority) => {
      const inPriority = reqs.filter((r) => r.priority === priority);
      const covered = inPriority.filter((r) => !coverage.uncovered_requirement_ids.includes(r.id)).length;
      return { priority, covered, total: inPriority.length };
    });
  })();

  return (
    <main className="mx-auto max-w-6xl px-6 py-8 lg:px-10">
      <header>
        <div className="min-w-0">
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 md:text-[2.25rem] lg:text-[2.5rem]">{kitTitle}</h1>
          <p className="mt-2 text-sm text-zinc-500">
            <span
              className={
                kit.status === "generated"
                  ? "rounded-full bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white"
                  : kit.status === "retrieved"
                    ? "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
                    : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600"
              }
            >
              {kit.status}
            </span>
            <span className="mx-1.5">·</span>
            {kit.input.days} prep days
            <span className="mx-1.5">·</span>
            Created {new Date(kit.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-zinc-950/10 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.eyebrow} className="bg-zinc-100 px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">{s.eyebrow}</div>
              <div className="mt-0.5 text-2xl font-semibold tracking-tight text-zinc-950">{s.value}</div>
            </div>
          ))}
        </div>
      </header>

      <nav
        className="mt-6 inline-flex max-w-full flex-wrap items-center gap-1 rounded-full bg-zinc-100 p-1"
        aria-label="Kit sections"
        role="tablist"
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
          const from = buttons.findIndex(
            (b) => b === document.activeElement || b.getAttribute("aria-selected") === "true",
          );
          const base = from >= 0 ? from : 0;
          const next = buttons[(base + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
          next?.focus();
          next?.click();
        }}
      >
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
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-white text-violet-700 shadow-sm"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {t.label}
              {typeof count === "number" && (
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    active ? "bg-violet-50 text-violet-700" : "bg-white/70 text-zinc-500"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 1 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >

      {tab === "overview" && (
        <>
          <InView>
          <section className="mt-4 rounded-xl border border-zinc-950/10 bg-white p-6">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Company URL</dt>
                <dd className="font-medium text-zinc-900">{kit.input.company_url}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Prep days</dt>
                <dd className="font-medium text-zinc-900">{kit.input.days}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Created</dt>
                <dd className="font-medium text-zinc-900">{new Date(kit.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">JD length</dt>
                <dd className="font-medium text-zinc-900">{kit.input.jd.length.toLocaleString()} chars</dd>
              </div>
            </dl>
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-zinc-700">Show job description</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-100 p-3 text-xs text-zinc-700">
                {kit.input.jd}
              </pre>
            </details>
          </section>
          </InView>

          <InView delay={0.08}>
          <section className="mt-6 rounded-xl border border-zinc-950/10 bg-white p-6">
            <h2 className="border-l-2 border-zinc-300 pl-2.5 text-base font-semibold text-zinc-900">Research</h2>
            <p className="mt-1 text-sm text-zinc-500">
              Crawls the company home page, ranks internal links (careers/culture/blog), respects robots.txt, and uses Tavily
              to find interview-process discussion.
            </p>
            <button
              onClick={() => void runRetrieval()}
              disabled={retrieving}
              className="mt-4 rounded-lg border border-zinc-950/10 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
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
                  <h3 className="text-sm font-semibold text-zinc-700">Pages used ({retrieval.pages_used.length})</h3>
                  <ul className="mt-2 space-y-1">
                    {retrieval.pages.map((p, i) => (
                      <li key={`${p.url}-${i}`} className="truncate rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm text-zinc-600">
                        <span className="mr-2 inline-block w-6 text-right text-xs text-zinc-400">{i + 1}</span>
                        <span className="font-medium text-zinc-900">{p.title || "(untitled)"}</span>{" "}
                        <span className="text-zinc-400">· d{p.depth}</span> — <span className="text-xs">{p.url}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {retrieval.search_hits.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-700">Interview-process discussion (Tavily) — {retrieval.search_hits.length} results</h3>
                    <ul className="mt-2 space-y-1.5">
                      {retrieval.search_hits.map((s, i) => (
                        <li key={`${s.url}-${i}`} className="text-sm">
                          <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-900">
                            {s.title}
                          </a>
                          {s.snippet && <p className="text-xs text-zinc-500">{s.snippet}</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {retrieval.robots_blocked.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-700">
                      robots.txt-blocked pages{" "}
                      <span className="font-normal text-zinc-500">({retrieval.robots_blocked.length} — skipped by this rule, not by accident)</span>
                    </h3>
                    <ul className="mt-2 space-y-1">
                      {retrieval.robots_blocked.map((b) => (
                        <li key={`${b.url}-${b.rule}`} className="truncate rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-xs text-zinc-600">
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">{b.rule}</span>{" "}
                          <span className="font-mono">{b.url}</span>
                          <span className="text-zinc-400"> (linked from {b.via})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <h3 className="text-sm font-semibold text-zinc-700">
                    Source failures logged{" "}
                    <span className="font-normal text-zinc-500">({retrieval.failures.length} — crawl continues past these)</span>
                  </h3>
                  {retrieval.failures.length === 0 ? (
                    <p className="mt-2 text-sm text-emerald-700">No failures this run — clean crawl.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {retrieval.failures.map((f, i) => (
                        <li key={`${f.source_url}-${i}`} className="truncate rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-xs text-zinc-600">
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
          </InView>

          <InView delay={0.16}>
          <section className="mt-6 rounded-xl border border-zinc-950/10 bg-white p-6">
            <h2 className="border-l-2 border-zinc-300 pl-2.5 text-base font-semibold text-zinc-900">Pipeline</h2>
            <p className="mt-1 text-sm text-zinc-500">
              One-click flow: for a draft kit, auto-runs retrieval first, then requirement extraction → per-category question
              generation → coverage loop → schedule → validation (LLM calls take ~1–2 minutes).
            </p>
            <button
              onClick={() => void runGenerate()}
              disabled={generating !== "idle"}
              className="mt-4 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
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

            <AnimatePresence>
              {generating !== "idle" && <GenerationProgress key={generating} phase={generating} />}
            </AnimatePresence>

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
                  <h3 className="text-sm font-semibold text-zinc-700">Company brief</h3>
                  <div className="mt-2 rounded-lg border border-zinc-950/10 bg-white p-3">
                    <div className="text-xs font-medium text-zinc-500">Summary</div>
                    <InlineEdit
                      value={brief.summary}
                      onSave={(v) => patchContent({ op: "update-brief", field: "summary", value: v })}
                      label="company brief summary"
                      textClass="mt-1 text-sm text-zinc-900"
                    />
                    {brief.what_they_do && (
                      <>
                        <div className="mt-3 text-xs font-medium text-zinc-500">What they do</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-600">{brief.what_they_do}</p>
                      </>
                    )}
                    {brief.sources.length > 0 && (
                      <div className="mt-3 text-xs text-zinc-500">
                        Sources: <span className="font-mono">{brief.sources.join(", ")}</span>
                      </div>
                    )}
                    <button
                      onClick={() => void regenerate({ op: "regenerate-brief" }, "brief")}
                      disabled={regenBusy !== null}
                      className="mt-3 rounded-lg border border-zinc-950/10 px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {regenBusy === "brief" ? "Regenerating brief…" : "Regenerate brief"}
                    </button>
                  </div>
                </div>

                {stageErrors.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-700">Stage degradations (log-and-continue)</h3>
                    <ul className="mt-2 space-y-1">
                      {stageErrors.map((e, i) => (
                        <li key={`${e.stage}-${i}`} className="truncate text-xs text-zinc-600">
                          <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] text-red-600">{e.code}</span> [{e.stage}] {e.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
          </InView>
        </>
      )}

      {tab === "requirements" && (
        <InView>
        <section className="mt-4 rounded-xl border border-zinc-950/10 bg-white p-6">
          <h2 className="border-l-2 border-zinc-300 pl-2.5 text-base font-semibold text-zinc-900">Requirements — {reqs.length} extracted</h2>
          {generated ? (
            <ul className="mt-2 grid grid-cols-1 gap-2">
              {reqs.map((r) => (
                <li key={r.id} className="rounded-lg border border-zinc-950/10 bg-white px-3 py-2 text-sm">
                  <span className="mr-2 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{r.id}</span>
                  <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[r.priority] ?? "bg-zinc-100 text-zinc-600"}`}>
                    {r.priority}
                  </span>
                  <span className="text-zinc-900">{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">Run Generate in Overview to extract requirements from the job description.</p>
          )}
        </section>
        </InView>
      )}

      {tab === "questions" && (
        <InView className="mt-4">
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold text-zinc-950">Question bank</h2>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              {questions.length} questions · {catCount} categories
            </span>
          </div>
          {generated ? (
            <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    { key: "all", label: "All", count: questions.length },
                    ...Object.keys(CATEGORY_LABELS)
                      .filter((c) => categoryCounts.has(c))
                      .map((c) => ({ key: c, label: CATEGORY_LABELS[c] ?? c, count: categoryCounts.get(c) ?? 0 })),
                  ].map((chip) => {
                    const active = qCategory === chip.key;
                    return (
                      <button
                        key={chip.key}
                        onClick={() => setQCategory(chip.key)}
                        aria-pressed={active}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-medium transition active:scale-[0.98]",
                          active
                            ? "border-zinc-900 bg-zinc-900 text-white"
                            : "border-zinc-950/10 bg-white text-zinc-600 hover:bg-zinc-100",
                        )}
                      >
                        {chip.label} <span className="text-zinc-400">{chip.count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={qText}
                    onChange={(e) => setQText(e.target.value)}
                    placeholder="Filter questions…"
                    aria-label="Filter questions"
                    className="min-w-0 flex-1 rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
                  />
                  <select
                    value={qSort}
                    onChange={(e) => setQSort(e.target.value as QuestionSort)}
                    aria-label="Sort questions"
                    className="rounded-lg border border-zinc-950/10 bg-white px-2 py-1.5 text-sm text-zinc-700 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
                  >
                    <option value="schedule">Schedule order</option>
                    <option value="difficulty">Difficulty</option>
                    <option value="confidence">Confidence</option>
                  </select>
                </div>

                <div className="mt-4">
                  <AddItemForm kind="question" onAdd={(payload) => patchContent(payload)} />
                </div>

                {visibleGroups.length === 0 && (
                  <p className="mt-4 rounded-xl border border-dashed border-zinc-950/15 px-4 py-8 text-center text-sm text-zinc-500">
                    No questions match these filters.
                  </p>
                )}

                {visibleGroups.map(({ category, items }) => {
                  const categoryItems = questions.filter((x) => x.category === category);
                  const move = async (id: string, dir: -1 | 1) => {
                    const idx = categoryItems.findIndex((q) => q.id === id);
                    const swap = idx + dir;
                    if (idx < 0 || swap < 0 || swap >= categoryItems.length) return;
                    const next = [...categoryItems];
                    [next[idx], next[swap]] = [next[swap], next[idx]];
                    await patchContent({ op: "reorder-questions", category, ordered_ids: next.map((q) => q.id) });
                  };
                  return (
                    <div key={category} className="mt-6">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[11px] uppercase tracking-wider text-zinc-500">
                          {CATEGORY_LABELS[category] ?? category} · {items.length}
                        </h3>
                        <button
                          onClick={() => void regenerate({ op: "regenerate-category", category }, `category:${category}`)}
                          disabled={regenBusy !== null}
                          className="rounded-lg border border-zinc-950/10 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {regenBusy === `category:${category}` ? "Regenerating…" : "Regenerate category"}
                        </button>
                      </div>
                      <ul className="mt-2 divide-y divide-zinc-950/10 overflow-hidden rounded-xl border border-zinc-950/10 bg-white">
                        {items.map((q) => {
                          const catIdx = categoryItems.findIndex((x) => x.id === q.id);
                          const diff =
                            DIFFICULTY_LABELS[Math.min(3, Math.max(1, Math.round(q.difficulty)))] ?? DIFFICULTY_LABELS[2];
                          const practiced = questionPracticed(q);
                          const expanded = expandedQ === q.id;
                          return (
                            <li key={q.id} className="bg-white px-4 py-4 transition hover:bg-zinc-50">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  title={practiced ? "Related flashcards have been practised" : "Not practised yet"}
                                  className={cn("h-2 w-2 shrink-0 rounded-full", practiced ? "bg-violet-600" : "bg-zinc-300")}
                                  aria-hidden
                                />
                                <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", diff.className)}>
                                  {diff.label}
                                </span>
                                <span className="text-xs text-zinc-500">{minutesForDifficulty(q.difficulty)} min</span>
                                <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
                                  {q.requirement_ids.map((rid) => (
                                    <span
                                      key={rid}
                                      className="rounded-full border border-zinc-950/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
                                    >
                                      {rid}
                                    </span>
                                  ))}
                                </span>
                                <span className="flex overflow-hidden rounded-lg border border-zinc-950/10">
                                  <button
                                    onClick={() => void move(q.id, -1)}
                                    disabled={patchBusy || catIdx <= 0}
                                    aria-label="Move question up"
                                    className="px-1.5 py-0.5 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    onClick={() => void move(q.id, 1)}
                                    disabled={patchBusy || catIdx >= categoryItems.length - 1}
                                    aria-label="Move question down"
                                    className="border-l border-zinc-950/10 px-1.5 py-0.5 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                                  >
                                    ↓
                                  </button>
                                </span>
                                <button
                                  onClick={() => setPendingDelete({ target: "questions", id: q.id, label: "question" })}
                                  className="rounded-lg border border-red-200 px-2 py-0.5 text-xs font-medium text-red-600 transition hover:bg-red-50 active:scale-[0.98]"
                                >
                                  Delete
                                </button>
                              </div>
                              <div className={cn("mt-2", !expanded && "line-clamp-2")}>
                                <InlineEdit
                                  value={q.prompt}
                                  onSave={(v) => patchContent({ op: "update-item", target: "questions", id: q.id, field: "prompt", value: v })}
                                  label="question prompt"
                                />
                              </div>
                              {q.prompt.length > 140 && (
                                <button
                                  onClick={() => setExpandedQ(expanded ? null : q.id)}
                                  className="mt-1 text-xs font-medium text-zinc-600 transition hover:text-zinc-900"
                                >
                                  {expanded ? "Show less" : "Show more"}
                                </button>
                              )}
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs font-medium text-zinc-600 transition hover:text-zinc-900">
                                  Answer outline
                                </summary>
                                <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-600">
                                  <InlineEdit
                                    value={q.answer_outline}
                                    onSave={(v) =>
                                      patchContent({ op: "update-item", target: "questions", id: q.id, field: "answer_outline", value: v })
                                    }
                                    label="answer outline"
                                    textClass="text-xs text-zinc-600"
                                  />
                                </div>
                              </details>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <aside className="w-full shrink-0 space-y-4 lg:sticky lg:top-6 lg:w-72">
                <div className="rounded-xl border border-zinc-950/10 bg-white p-4">
                  <div className="text-[11px] uppercase tracking-wider text-zinc-500">Next up</div>
                  {nextCard ? (
                    <>
                      <p className="line-clamp-4 mt-2 text-sm text-zinc-800">{nextCard.front}</p>
                      <button
                        onClick={() => setTab("practice")}
                        className="mt-3 w-full rounded-lg border border-zinc-950/10 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98]"
                      >
                        Practice
                      </button>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-zinc-500">No flashcards yet.</p>
                  )}
                </div>
                <div className="rounded-xl border border-zinc-950/10 bg-white p-4">
                  <div className="text-[11px] uppercase tracking-wider text-zinc-500">Coverage</div>
                  {coverageStats && coverageStats.length > 0 ? (
                    coverageStats.map((s) => (
                      <div key={s.priority} className="mt-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium capitalize text-zinc-700">{s.priority}</span>
                          <span className="text-zinc-500">
                            {s.covered}/{s.total}
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                          <div
                            className="h-full rounded-full bg-violet-600"
                            style={{ width: `${s.total ? Math.round((s.covered / s.total) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="mt-2 text-sm text-zinc-500">Run Generate in Overview to compute coverage.</p>
                  )}
                </div>
              </aside>
            </div>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">Run Generate in Overview to create questions.</p>
          )}
        </section>
        </InView>
      )}

      {tab === "flashcards" && (
        <InView className="mt-4">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-950">Flashcards</h2>
              <p className="mt-0.5 text-[11px] uppercase tracking-wider text-zinc-500">{flashes.length} cards</p>
            </div>
            <AddItemForm kind="flashcard" onAdd={(payload) => patchContent(payload)} />
          </div>
          {generated && flashes.length > 0 ? (
            <div
              className="mt-4"
              onKeyDown={(e) => {
                const tag = (e.target as HTMLElement).tagName;
                if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
                if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  goFlash(-1);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  goFlash(1);
                }
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => goFlash(-1)}
                  disabled={activeFlashIdx <= 0}
                  className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Previous
                </button>
                <span className="text-xs text-zinc-500" aria-live="polite">
                  {activeFlashIdx + 1} / {flashes.length}
                </span>
                <button
                  onClick={() => goFlash(1)}
                  disabled={activeFlashIdx >= flashes.length - 1}
                  className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Next
                </button>
              </div>
              <TransitionPanel activeIndex={activeFlashIdx} className="mt-3 overflow-hidden">
                {flashes.map((f) => (
                  <div key={f.id} className="rounded-xl border border-zinc-950/10 bg-white p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-[11px] uppercase tracking-wider text-zinc-500">
                        {f.requirement_ids.length ? f.requirement_ids.join(" · ") : "Flashcard"}
                      </div>
                      <button
                        onClick={() => setPendingDelete({ target: "flashcards", id: f.id, label: "flashcard" })}
                        className="rounded-lg border border-red-200 px-2 py-0.5 text-xs font-medium text-red-600 transition hover:bg-red-50 active:scale-[0.98]"
                      >
                        Delete
                      </button>
                    </div>
                    <div className="mt-2">
                      <InlineEdit
                        value={f.front}
                        onSave={(v) => patchContent({ op: "update-item", target: "flashcards", id: f.id, field: "front", value: v })}
                        label="flashcard front"
                        textClass="text-lg font-medium text-zinc-900"
                      />
                    </div>
                    {fRevealed ? (
                      <div className="mt-4 rounded-xl bg-zinc-100 p-4">
                        <div className="text-[11px] uppercase tracking-wider text-zinc-500">Back</div>
                        <div className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">
                          <InlineEdit
                            value={f.back}
                            onSave={(v) => patchContent({ op: "update-item", target: "flashcards", id: f.id, field: "back", value: v })}
                            label="flashcard back"
                            textClass="text-sm text-zinc-800"
                          />
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setFRevealed(true)}
                        className="mt-4 rounded-lg border border-zinc-950/10 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98]"
                      >
                        Reveal
                      </button>
                    )}
                  </div>
                ))}
              </TransitionPanel>
            </div>
          ) : generated ? (
            <p className="mt-4 text-sm text-zinc-500">No flashcards yet — add one above.</p>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">Run Generate in Overview to create flashcards.</p>
          )}
        </section>
        </InView>
      )}

      {tab === "practice" && (
        <InView className="mt-4">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-950">Practice</h2>
              <p className="mt-0.5 text-[11px] uppercase tracking-wider text-zinc-500">
                {reviewedCount} / {flashes.length} reviewed
              </p>
            </div>
            <button
              onClick={toggleLowestFirst}
              aria-pressed={lowestFirst}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98]",
                lowestFirst
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-950/10 bg-white text-zinc-600 hover:bg-zinc-100",
              )}
            >
              {lowestFirst ? "Lowest confidence first" : "Deck order"}
            </button>
          </div>

          {flashes.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No flashcards yet — run Generate in Overview to create a deck.</p>
          ) : practiceCursor === "__done__" ? (
            <div className="mt-4 rounded-xl border border-zinc-950/10 bg-white px-4 py-8 text-center">
              <p className="text-sm font-medium text-zinc-900">Deck complete</p>
              <p className="mt-1 text-sm text-zinc-500">All {flashes.length} cards reviewed.</p>
              <button
                onClick={() => {
                  setPracticeCursor(null);
                  setRevealed(false);
                  setPracticeError(null);
                }}
                className="mt-4 rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 active:scale-[0.98]"
              >
                Review again
              </button>
            </div>
          ) : current ? (
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>{reviewedCount} of {flashes.length} reviewed</span>
                <span>
                  Card {activeIndexText + 1} of {deck.length}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full bg-violet-600"
                  style={{ width: `${Math.round((reviewedCount / flashes.length) * 100)}%` }}
                />
              </div>
              {practiceError && (
                <p role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                  {practiceError} — your rating is kept locally.
                </p>
              )}
              <div className="mt-4 rounded-xl border border-zinc-950/10 bg-white p-6">
                <p className="text-center text-[11px] uppercase tracking-wider text-zinc-500">Front</p>
                <p className="mt-2 text-center text-lg font-medium text-zinc-900">{current.front}</p>
                {revealed ? (
                  <div className="mt-4">
                    <div className="rounded-xl bg-zinc-100 p-4">
                      <p className="text-[11px] uppercase tracking-wider text-zinc-500">Back</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">{current.back}</p>
                    </div>
                    <div
                      className="mt-4 flex overflow-hidden rounded-lg border border-zinc-950/10"
                      role="group"
                      aria-label="How well did you know this card?"
                    >
                      {(["low", "medium", "high"] as const).map((c, i) => (
                        <button
                          key={c}
                          onClick={() => answerCard(c)}
                          className={cn(
                            "flex-1 px-4 py-2 text-sm font-medium transition active:scale-[0.98]",
                            i > 0 && "border-l border-zinc-950/10",
                            CONFIDENCE_STYLES[c],
                          )}
                        >
                          {c === "low" ? "Low" : c === "medium" ? "Medium" : "High"}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 flex justify-center">
                    <button
                      onClick={() => setRevealed(true)}
                      className="rounded-full bg-violet-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-700 active:scale-[0.98]"
                    >
                      Reveal answer
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </section>
        </InView>
      )}

      {tab === "schedule" && (
        <InView className="mt-4">
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-zinc-950">Schedule</h2>
              <p className="mt-0.5 text-[11px] uppercase tracking-wider text-zinc-500">{scheduleDays} days planned</p>
            </div>
            <button
              onClick={() => void regenerate({ op: "regenerate-schedule" }, "schedule")}
              disabled={regenBusy !== null}
              className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {regenBusy === "schedule" ? "Regenerating schedule…" : "Regenerate schedule"}
            </button>
          </div>
          {generated ? (
            <>
              {noScheduleMaterial && (
                <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  This job description didn&apos;t contain enough detail to generate a study plan.
                </p>
              )}
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {schedule.map((d) => {
                  const isEmpty = d.minutes === 0 || d.question_ids.length === 0;
                  return (
                    <div
                      key={d.day}
                      className={cn(
                        "rounded-xl border bg-white p-4",
                        isEmpty ? "border-dashed border-zinc-950/15" : "border-zinc-950/10",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] uppercase tracking-wider text-zinc-500">Day {d.day}</span>
                        {!isEmpty && <span className="text-xs text-zinc-500">{d.minutes} min</span>}
                      </div>
                      {isEmpty ? (
                        <p className="mt-2 text-sm italic text-zinc-400">Review day, no new material scheduled</p>
                      ) : (
                        <>
                          <p className="mt-1.5 text-sm font-medium text-zinc-900">{d.focus}</p>
                          <p className="mt-2 font-mono text-[10px] leading-4 text-zinc-500">{d.question_ids.join(", ")}</p>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {coverage && coverage.uncovered_requirement_ids.length > 0 && (
                <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Coverage left uncovered (honest): {coverage.uncovered_requirement_ids.join(", ")} after {coverage.passes} pass(es)
                </p>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">Run Generate in Overview to create a study plan.</p>
          )}
        </section>
        </InView>
      )}

        </motion.div>
      </AnimatePresence>

      <details className="mt-6 rounded-xl border border-zinc-950/10 bg-white p-4">
        <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 transition hover:text-zinc-900">
          <span className="inline-flex items-center gap-2">
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600">json</span>
            Developer view
          </span>
        </summary>
        <p className="mt-2 text-xs text-zinc-500">Raw model as persisted in MongoDB — confirms the save path and output contract fields.</p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-zinc-950 p-4 text-xs text-zinc-100">
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
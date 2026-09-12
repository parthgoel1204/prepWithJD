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
    failures: RetrievalFailure[];
  };
}

type LoadState = "loading" | "loaded" | "error";

export default function KitDetail() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [kit, setKit] = useState<KitFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [retrieving, setRetrieving] = useState(false);
  const [retrieval, setRetrieval] = useState<RetrievalResultResponse["retrieval"] | null>(null);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);

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
          Crawls the company home page, ranks internal links (careers/culture/blog), respects robots.txt, and searches
          Brave for interview-process discussion.
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
                  <li key={p.url} className="truncate text-sm text-slate-600">
                    <span className="mr-2 inline-block w-6 text-right text-xs text-slate-400">{i + 1}</span>
                    <span className="font-medium text-slate-800">{p.title || "(untitled)"}</span>{" "}
                    <span className="text-slate-400">· d{p.depth}</span> — <span className="text-xs">{p.url}</span>
                  </li>
                ))}
              </ul>
            </div>

            {retrieval.search_hits.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Interview-process discussion (Brave) — {retrieval.search_hits.length} results</h3>
                <ul className="mt-2 space-y-1.5">
                  {retrieval.search_hits.map((s) => (
                    <li key={s.url} className="text-sm">
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-medium text-indigo-600 hover:underline">
                        {s.title}
                      </a>
                      {s.snippet && <p className="text-xs text-slate-500">{s.snippet}</p>}
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
        <h2 className="text-base font-semibold text-slate-800">Stored kit document (contract shape)</h2>
        <p className="mt-1 text-sm text-slate-500">Raw model as persisted in MongoDB — confirms the save path and output contract fields.</p>
        <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
          {JSON.stringify(kit, null, 2)}
        </pre>
      </section>
    </main>
  );
}
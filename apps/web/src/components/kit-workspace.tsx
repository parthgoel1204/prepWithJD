"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface KitListItem {
  _id: string;
  status: string;
  input: { jd: string; company_url: string; days: number; file_name?: string };
  createdAt: string;
  updatedAt: string;
}

interface KitListResponse {
  kits: KitListItem[];
}

type SubmitState = "idle" | "saving" | "saved" | "error";

export default function KitWorkspace() {
  const [kits, setKits] = useState<KitListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState(5);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const [batchState, setBatchState] = useState<SubmitState>("idle");
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await apiFetch<KitListResponse>("/api/kits");
      setKits(data.kits ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load kits");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load
    void refresh();
  }, [refresh]);

  const createSingle = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitState("saving");
    setSubmitMessage(null);
    try {
      const res = await apiFetch<{ kit: KitListItem }>("/api/kits", {
        method: "POST",
        body: JSON.stringify({ jd, company_url: companyUrl, days }),
      });
      setKits((prev) => [res.kit, ...prev]);
      setJd("");
      setCompanyUrl("");
      setDays(5);
      setSubmitState("saved");
      setSubmitMessage("Saved. Open the kit to run retrieval.");
    } catch (err) {
      setSubmitState("error");
      setSubmitMessage(err instanceof Error ? err.message : "Failed to save kit");
    }
  };

  const parseBatchFile = async (file: File): Promise<Array<{ jd: string; company_url: string; days?: number }>> => {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("Batch file must be a JSON array of {jd, company_url, days} objects");
    for (const item of parsed) {
      if (!item || typeof item.jd !== "string" || typeof item.company_url !== "string") {
        throw new Error("Each batch item needs a string jd and company_url");
      }
    }
    return parsed;
  };

  const uploadBatch = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBatchState("saving");
    setBatchMessage(null);
    try {
      const items = await parseBatchFile(file);
      const res = await apiFetch<{ count: number }>("/api/kits/batch", {
        method: "POST",
        body: JSON.stringify({ items }),
      });
      setBatchState("saved");
      setBatchMessage(`Imported ${res.count} kits from ${file.name}.`);
      await refresh();
    } catch (err) {
      setBatchState("error");
      setBatchMessage(err instanceof Error ? err.message : "Failed to parse/upload batch file");
    } finally {
      e.target.value = "";
    }
  };

  const deleteKit = async (id: string) => {
    try {
      await apiFetch<{ ok: boolean }>(`/api/kits/${id}`, { method: "DELETE" });
      setKits((prev) => prev.filter((k) => k._id !== id));
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to delete kit");
    }
  };

  const logout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Full reload: clears client state even when a stale component is mounted.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- session teardown forces a clean reload
      window.location.assign("/login");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">prepWithJD</h1>
          <p className="text-sm text-slate-500">Paste a JD, point at a company, and start research.</p>
        </div>
        <button onClick={logout} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">
          Log out
        </button>
      </header>

      {/* Single kit form */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">New kit</h2>
        <form onSubmit={createSingle} className="mt-4 space-y-4">
          <div>
            <label htmlFor="company-url" className="mb-1 block text-sm font-medium text-slate-700">Company URL</label>
            <input
              id="company-url"
              type="url"
              required
              placeholder="https://acme.example"
              value={companyUrl}
              onChange={(e) => setCompanyUrl(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div>
            <label htmlFor="jd" className="mb-1 block text-sm font-medium text-slate-700">Job description</label>
            <textarea
              id="jd"
              required
              rows={6}
              placeholder="Paste the full job description here…"
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <label htmlFor="days" className="mb-1 block text-sm font-medium text-slate-700">Prep days</label>
              <input
                id="days"
                type="number"
                min={1}
                max={60}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
            </div>
            <button
              type="submit"
              disabled={submitState === "saving"}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitState === "saving" ? "Saving…" : "Save kit (draft)"}
            </button>
          </div>
        </form>

        {submitState === "saved" && (
          <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {submitMessage}
          </div>
        )}
        {submitState === "error" && (
          <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {submitMessage}
          </div>
        )}
      </section>

      {/* Batch upload */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">Batch prep (file)</h2>
        <p className="mt-1 text-sm text-slate-500">
          Upload a JSON file: <code className="rounded bg-slate-100 px-1 text-xs">[{"{jd, company_url, days}"}, …]</code>
        </p>
        <label
          className="mt-4 flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500 hover:border-indigo-400 hover:text-indigo-600"
        >
          {batchState === "saving" ? "Uploading…" : "Choose JSON file"}
          <input type="file" accept="application/json,.json" className="hidden" onChange={uploadBatch} disabled={batchState === "saving"} />
        </label>
        {batchMessage && (
          <div
            role={batchState === "error" ? "alert" : "status"}
            className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
              batchState === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            {batchMessage}
          </div>
        )}
      </section>

      {/* Kits list */}
      <section className="mt-8">
        <h2 className="text-base font-semibold text-slate-800">Your kits</h2>
        {listLoading && <p className="mt-3 text-sm text-slate-500">Loading your kits…</p>}
        {listError && (
          <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {listError}
          </div>
        )}
        {!listLoading && !listError && kits.length === 0 && (
          <p className="mt-3 rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
            No kits yet. Save your first one above.
          </p>
        )}
        <ul className="mt-3 space-y-3">
          {kits.map((kit) => (
            <li key={kit._id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link href={`/kits/${kit._id}`} className="truncate text-sm font-medium text-indigo-600 hover:underline">
                    {kit.input.company_url}
                  </Link>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      kit.status === "generated"
                        ? "bg-emerald-100 text-emerald-700"
                        : kit.status === "retrieved"
                          ? "bg-sky-100 text-sky-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {kit.status}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {kit.input.jd.length.toLocaleString()} chars · {kit.input.days} days ·{" "}
                  {new Date(kit.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Link href={`/kits/${kit._id}`} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100">
                  Open
                </Link>
                <button onClick={() => void deleteKit(kit._id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50">
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
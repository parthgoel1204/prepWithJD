"use client";

import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { ApiError, apiFetch, apiUpload } from "@/lib/api";
import { BorderTrail } from "@/components/core/border-trail";
import { cn } from "@/lib/utils";
import { FolderOpen, Upload } from "lucide-react";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const UPLOAD_TYPES = [".pdf", ".docx"];

function uploadErrorLabel(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 413) return "File is too large; the limit is 5 MB.";
    switch (err.code) {
      case "FILE_TOO_LARGE":
        return "File is too large; the limit is 5 MB.";
      case "UNSUPPORTED_FILE_TYPE":
        return "Unsupported file type; upload a .pdf or .docx.";
      case "TEXT_TOO_LONG":
        return "The description is over 50,000 characters; trim it and try again.";
      case "NO_TEXT_FOUND":
        return "No readable text found. If this is a scanned PDF, paste the text manually.";
      case "UNREADABLE_FILE":
        return "Could not read the file; it may be corrupt or password-protected.";
    }
  }
  return err instanceof Error ? err.message : "Failed to extract text from the file";
}

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

const STATUS_STYLES: Record<string, string> = {
  generated: "bg-violet-50 text-violet-700",
  retrieved: "bg-zinc-100 text-zinc-700",
};

export default function KitWorkspace() {
  const reduceMotion = useReducedMotion();

  const [kits, setKits] = useState<KitListItem[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [jd, setJd] = useState("");
  const [companyUrl, setCompanyUrl] = useState("");
  const [days, setDays] = useState(5);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  const [jdFile, setJdFile] = useState<string | null>(null);
  const [jdUploadState, setJdUploadState] = useState<SubmitState>("idle");
  const [jdUploadMessage, setJdUploadMessage] = useState<string | null>(null);

  const [batchState, setBatchState] = useState<SubmitState>("idle");
  const [batchMessage, setBatchMessage] = useState<string | null>(null);

  const [jdFocused, setJdFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

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
        body: JSON.stringify({ jd, company_url: companyUrl, days, file_name: jdFile ?? undefined }),
      });
      setKits((prev) => [res.kit, ...prev]);
      setJd("");
      setCompanyUrl("");
      setDays(5);
      setJdFile(null);
      setJdUploadState("idle");
      setJdUploadMessage(null);
      setSubmitState("saved");
      setSubmitMessage("Saved. Open the kit to run retrieval.");
    } catch (err) {
      setSubmitState("error");
      setSubmitMessage(err instanceof Error ? err.message : "Failed to save kit");
    }
  };

  const handleJdFile = async (file: File | undefined) => {
    if (!file) return;
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (!UPLOAD_TYPES.includes(ext)) {
      setJdUploadState("error");
      setJdUploadMessage("Unsupported file type; upload a .pdf or .docx.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setJdUploadState("error");
      setJdUploadMessage("File is too large; the limit is 5 MB.");
      return;
    }
    setJdUploadState("saving");
    setJdUploadMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiUpload<{ text: string }>("/api/jd/extract", form);
      setJd(res.text);
      setJdFile(file.name);
      setJdUploadState("saved");
      setJdUploadMessage(`Extracted from ${file.name}, review before generating.`);
    } catch (err) {
      setJdUploadState("error");
      setJdUploadMessage(uploadErrorLabel(err));
    }
  };

  const uploadJd = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleJdFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const dropJd = async (e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setIsDragging(false);
    void handleJdFile(e.dataTransfer.files?.[0]);
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950">Kits</h1>
        <p className="mt-1 text-sm text-zinc-500">Paste a JD, point at a company, and start research.</p>
      </header>

      {/* Single kit form */}
      <section className="rounded-xl border border-zinc-950/10 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-950">New kit</h2>
        <form onSubmit={createSingle} className="mt-5 space-y-5">
          <div>
            <label htmlFor="company-url" className="mb-1.5 block text-sm font-medium text-zinc-700">
              Company URL
            </label>
            <input
              id="company-url"
              type="url"
              required
              placeholder="https://acme.example"
              value={companyUrl}
              onChange={(e) => setCompanyUrl(e.target.value)}
              className="w-full rounded-lg border border-zinc-950/10 bg-white px-3 py-2 text-sm text-zinc-900 transition placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
            />
          </div>
          <div>
            <label htmlFor="jd" className="mb-1.5 block text-sm font-medium text-zinc-700">
              Job description
            </label>
            <div
              className={cn(
                "relative overflow-hidden rounded-xl border bg-white transition",
                isDragging ? "border-violet-600 ring-2 ring-violet-600/20" : "border-zinc-950/10",
                jdFocused && "focus-within:border-violet-600",
              )}
            >
              {jdFocused && !reduceMotion && (
                <BorderTrail size={120} className="bg-gradient-to-r from-violet-600 via-indigo-500 to-blue-500" />
              )}
              <textarea
                id="jd"
                required
                rows={6}
                placeholder="Paste the full job description here, or drop a PDF/DOCX onto this box…"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                onFocus={() => setJdFocused(true)}
                onBlur={() => setJdFocused(false)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(e) => void dropJd(e)}
                className="w-full resize-y border-none bg-transparent px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-0"
              />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60">
                <Upload className="h-4 w-4" />
                {jdUploadState === "saving" ? "Extracting…" : "Upload PDF/DOCX"}
                <input type="file" accept=".pdf,.docx" className="hidden" onChange={(e) => void uploadJd(e)} disabled={jdUploadState === "saving"} />
              </label>
              <span className="text-xs text-zinc-500">or drop a file onto the box above</span>
            </div>
            {jdUploadMessage && (
              <div
                role={jdUploadState === "error" ? "alert" : "status"}
                className={cn(
                  "mt-3 rounded-lg border px-3 py-2 text-sm",
                  jdUploadState === "error"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-violet-600/20 bg-violet-50 text-violet-700",
                )}
              >
                {jdUploadMessage}
              </div>
            )}
          </div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <label htmlFor="days" className="mb-1.5 block text-sm font-medium text-zinc-700">
                Prep days
              </label>
              <input
                id="days"
                type="number"
                min={1}
                max={60}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-24 rounded-lg border border-zinc-950/10 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
              />
            </div>
            <button
              type="submit"
              disabled={submitState === "saving"}
              className="rounded-full bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitState === "saving" ? "Saving…" : "Save kit (draft)"}
            </button>
          </div>
        </form>

        {submitState === "saved" && (
          <div role="status" className="mt-4 rounded-lg border border-violet-600/20 bg-violet-50 px-3 py-2 text-sm text-violet-700">
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
      <section className="mt-6 rounded-xl border border-zinc-950/10 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-950">Batch prep (file)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Upload a JSON file: <code className="rounded bg-zinc-100 px-1 text-xs text-zinc-700">[{"{jd, company_url, days}"}, …]</code>
        </p>
        <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-950/20 px-4 py-6 text-sm text-zinc-500 transition hover:border-violet-600/60 hover:text-violet-700 active:scale-[0.99]">
          <Upload className="h-4 w-4" />
          {batchState === "saving" ? "Uploading…" : "Choose JSON file"}
          <input type="file" accept="application/json,.json" className="hidden" onChange={uploadBatch} disabled={batchState === "saving"} />
        </label>
        {batchMessage && (
          <div
            role={batchState === "error" ? "alert" : "status"}
            className={cn(
              "mt-4 rounded-lg border px-3 py-2 text-sm",
              batchState === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-violet-600/20 bg-violet-50 text-violet-700",
            )}
          >
            {batchMessage}
          </div>
        )}
      </section>

      {/* Kits list */}
      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-zinc-950">Your kits</h2>
          {!listLoading && !listError && kits.length > 0 && (
            <span className="text-xs uppercase tracking-wider text-zinc-500">{kits.length} total</span>
          )}
        </div>
        {listLoading && (
          <div className="mt-4 space-y-3" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl border border-zinc-950/10 bg-zinc-100" />
            ))}
          </div>
        )}
        {listError && (
          <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {listError}
          </div>
        )}
        {!listLoading && !listError && kits.length === 0 && (
          <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-zinc-950/15 bg-white px-4 py-10 text-center">
            <FolderOpen className="h-8 w-8 text-zinc-400" aria-hidden />
            <p className="mt-3 text-sm text-zinc-600">No kits yet.</p>
            <p className="mt-0.5 text-sm text-zinc-500">Save your first one above.</p>
          </div>
        )}
        <ul className="mt-4 space-y-3">
          {kits.map((kit) => (
            <li
              key={kit._id}
              className="rounded-xl border border-zinc-950/10 bg-white px-4 py-3.5 transition hover:border-zinc-950/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/kits/${kit._id}`}
                      className="truncate text-sm font-medium text-violet-700 hover:text-violet-800 hover:underline"
                    >
                      {kit.input.company_url}
                    </Link>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_STYLES[kit.status] ?? "bg-zinc-100 text-zinc-600",
                      )}
                    >
                      {kit.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-zinc-500">
                    {kit.input.jd.length.toLocaleString()} chars · {kit.input.days} days
                    {kit.input.file_name ? ` · ${kit.input.file_name}` : ""} ·{" "}
                    {new Date(kit.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link
                    href={`/kits/${kit._id}`}
                    className="rounded-lg border border-zinc-950/10 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98]"
                  >
                    Open
                  </Link>
                  <button
                    onClick={() => void deleteKit(kit._id)}
                    className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 active:scale-[0.98]"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Mail, Lock, User } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface AuthFormFields {
  name?: string;
  email: string;
  password: string;
}

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionExpired = searchParams.get("reason") === "session_expired";
  const isLogin = mode === "login";
  const [form, setForm] = useState<AuthFormFields>({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH === "1";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      router.replace("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  };

  const set =
    (field: keyof AuthFormFields) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-2">
      <div className="flex items-center justify-center px-4 py-10 sm:px-6">
        <div className="w-full max-w-sm">
          <div className="text-sm font-medium tracking-tight text-zinc-900">prepWithJD</div>
          <h1 className="mt-8 text-balance text-3xl font-semibold tracking-tight text-zinc-900">
            {isLogin ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-2 text-sm text-zinc-600">
            {isLogin ? "Welcome back — continue your prep." : "New here? Your kits are saved to your account."}
          </p>

          {sessionExpired && (
            <div
              role="status"
              className="mt-5 rounded-lg border border-amber-200/70 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              Session expired, please log in again.
            </div>
          )}

          <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
            {!isLogin && (
              <div>
                <label htmlFor="name" className="mb-1.5 block text-sm font-medium text-zinc-700">
                  Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    id="name"
                    type="text"
                    required
                    value={form.name}
                    onChange={set("name")}
                    className="w-full rounded-lg border border-zinc-950/10 bg-white pl-9 pr-3 py-2 text-sm text-zinc-900 shadow-[0_1px_1px_rgba(0,0,0,0.01)] transition placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
                  />
                </div>
              </div>
            )}
            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-zinc-700">
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={form.email}
                  onChange={set("email")}
                  className="w-full rounded-lg border border-zinc-950/10 bg-white pl-9 pr-3 py-2 text-sm text-zinc-900 shadow-[0_1px_1px_rgba(0,0,0,0.01)] transition placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
                />
              </div>
            </div>
            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-zinc-700">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <input
                  id="password"
                  type="password"
                  required
                  minLength={isLogin ? 1 : 8}
                  autoComplete={isLogin ? "current-password" : "new-password"}
                  value={form.password}
                  onChange={set("password")}
                  className="w-full rounded-lg border border-zinc-950/10 bg-white pl-9 pr-3 py-2 text-sm text-zinc-900 shadow-[0_1px_1px_rgba(0,0,0,0.01)] transition placeholder:text-zinc-400 focus:border-violet-600 focus:outline-none focus:ring-2 focus:ring-violet-600/20"
                />
              </div>
            </div>

            {error && (
              <div role="alert" className="rounded-lg border border-red-200/70 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-zinc-950 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-900 active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "One moment…" : isLogin ? "Sign in" : "Create account"}
            </button>
          </form>

          {googleEnabled && (
            <div className="mt-5 space-y-4">
              <div className="relative flex items-center justify-center">
                <div className="h-px w-full bg-zinc-950/10" />
                <span className="absolute bg-white px-3 text-[11px] uppercase tracking-[0.2em] text-zinc-500">or</span>
              </div>
              <button
                type="button"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-950/10 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-[0_1px_1px_rgba(0,0,0,0.01)] transition hover:bg-zinc-50 active:scale-[0.995]"
              >
                Continue with Google
              </button>
            </div>
          )}

          <p className="mt-5 text-center text-sm text-zinc-600">
            {isLogin ? (
              <>
                No account?{" "}
                <Link href="/register" className="font-medium text-violet-700 hover:text-violet-800 hover:underline">
                  Register
                </Link>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-violet-700 hover:text-violet-800 hover:underline">
                  Log in →
                </Link>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="relative hidden items-center justify-center bg-zinc-100 md:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(circle_at_1px_1px,rgba(15,23,42,0.08)_1px,transparent_0)] [background-size:40px_40px]"
        />
        <div className="relative z-10 max-w-md px-8">
          <p className="text-lg font-medium tracking-tight text-zinc-900">
            Turn a job description into a structured interview-prep kit.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-zinc-600">
            Research the company, extract requirements, generate questions, build flashcards and a day-by-day schedule — all editable in one place.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-950/10 bg-white p-3 shadow-[0_1px_1px_rgba(0,0,0,0.01)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 1</div>
              <div className="mt-1 text-sm font-medium text-zinc-900">Paste a JD</div>
            </div>
            <div className="rounded-lg border border-zinc-950/10 bg-white p-3 shadow-[0_1px_1px_rgba(0,0,0,0.01)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 2</div>
              <div className="mt-1 text-sm font-medium text-zinc-900">We research the company</div>
            </div>
            <div className="col-span-2 rounded-lg border border-zinc-950/10 bg-white p-3 shadow-[0_1px_1px_rgba(0,0,0,0.01)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 3</div>
              <div className="mt-1 text-sm font-medium text-zinc-900">Practice a scheduled plan</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
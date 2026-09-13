"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

interface AuthFormFields {
  name?: string;
  email: string;
  password: string;
}

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // After an expired/invalid session the fetch wrapper redirects here with a reason.
  const sessionExpired = searchParams.get("reason") === "session_expired";
  const isLogin = mode === "login";
  const [form, setForm] = useState<AuthFormFields>({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    <div className="mx-auto mt-16 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-semibold text-slate-900">{isLogin ? "Log in" : "Create account"}</h1>
      <p className="mt-1 text-sm text-slate-500">{isLogin ? "Welcome back — continue your prep." : "New here? Your kits are saved to your account."}</p>

      {sessionExpired && (
        <div role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Session expired, please log in again.
        </div>
      )}

      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {!isLogin && (
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-medium text-slate-700">Name</label>
            <input
              id="name"
              type="text"
              required
              value={form.name}
              onChange={set("name")}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>
        )}
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={isLogin ? 1 : 8}
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={form.password}
            onChange={set("password")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "One moment…" : isLogin ? "Log in" : "Create account"}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-slate-500">
        {isLogin ? (
          <>
            No account?{" "}
            <Link href="/register" className="font-medium text-indigo-600 hover:underline">Register</Link>
          </>
        ) : (
          <>
            Already registered?{" "}
            <Link href="/login" className="font-medium text-indigo-600 hover:underline">Log in</Link>
          </>
        )}
      </p>
    </div>
  );
}
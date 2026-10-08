"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, Menu, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface UserMe {
  user: { email: string; name?: string };
}

const NAV_ITEMS = [{ href: "/dashboard", label: "Kits", icon: Home }];

function getBreadcrumb(pathname: string) {
  if (pathname.startsWith("/kits/")) return { label: "Kit detail", back: "/dashboard" };
  if (pathname.startsWith("/dashboard")) return { label: "Kits", back: null };
  return { label: "", back: null };
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<UserMe>("/api/auth/me");
        setEmail(res.user.email);
      } catch {
        setEmail(null);
      } finally {
        setLoadingUser(false);
      }
    })();
  }, []);

  const logout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  };

  const crumb = getBreadcrumb(pathname ?? "");

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-72 -translate-x-full border-r border-zinc-950/10 bg-white/95 backdrop-blur-sm transition-transform md:static md:translate-x-0",
          sidebarOpen && "translate-x-0",
        )}
      >
        <div className="flex h-full flex-col px-4 py-5">
          <div className="flex items-center justify-between">
            <Link href="/dashboard" className="text-sm font-medium tracking-tight text-zinc-900">
              prepWithJD
            </Link>
            <button
              className="rounded-lg p-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <nav className="mt-6 flex flex-1 flex-col gap-1">
            {NAV_ITEMS.map((item) => {
              const active = pathname?.startsWith(item.href) ?? false;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition hover:bg-zinc-100",
                    active ? "bg-violet-50 text-violet-700" : "text-zinc-700",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-4 border-t border-zinc-950/10 pt-4">
            <div className="truncate text-xs text-zinc-500">
              {loadingUser ? "Loading…" : email ?? "Signed in"}
            </div>
            <button
              onClick={() => void logout()}
              className="mt-2 w-full rounded-lg border border-zinc-950/10 bg-white px-2.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-100 active:scale-[0.98]"
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-zinc-900/40 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />
      )}
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-zinc-950/10 bg-white/80 px-4 py-3 backdrop-blur-sm md:hidden">
          <button
            className="rounded-lg p-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="text-sm font-medium text-zinc-900">{crumb.label || "prepWithJD"}</div>
          {crumb.back ? (
            <Link href={crumb.back} className="text-xs text-violet-700 hover:text-violet-800">
              Back
            </Link>
          ) : (
            <div />
          )}
        </header>
        <header className="hidden items-center justify-between border-b border-zinc-950/10 bg-white/80 px-6 py-3 backdrop-blur-sm md:flex">
          <div className="text-sm font-medium text-zinc-900">{crumb.label || "prepWithJD"}</div>
          {crumb.back ? (
            <Link href={crumb.back} className="text-sm text-violet-700 hover:text-violet-800">
              Back
            </Link>
          ) : (
            <div />
          )}
        </header>
        <main className="flex-1 bg-zinc-50">{children}</main>
      </div>
    </div>
  );
}
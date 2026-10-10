import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { InView } from "@/components/core/in-view";
import { HeroIllustration } from "@/components/hero-illustration";

export default async function Home() {
  const cookieStore = await cookies();
  const hasSession = cookieStore.has("sid");
  if (hasSession) {
    redirect("/dashboard");
  }

  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <div className="text-sm font-medium tracking-tight text-zinc-900">prepWithJD</div>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login" className="text-zinc-600 transition hover:text-zinc-900">
            Log in
          </Link>
          <Link
            href="/register"
            className="rounded-full bg-zinc-950 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-900 active:scale-[0.98]"
          >
            Get started
          </Link>
        </nav>
      </header>

      <HeroIllustration />

      <InView className="mx-auto max-w-5xl px-4 pt-12 sm:pt-16 md:pt-20">
        <div className="text-center">
          <div className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-zinc-950/10 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            Interview Prep Kit
          </div>
          <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight text-zinc-950 sm:text-5xl md:text-6xl">
            One platform for interview preparation
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-balance text-base text-zinc-600">
            Turn a job description and a company URL into a personalised prep kit — briefs, requirements, questions, flashcards and a day-by-day schedule.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/register"
              className="rounded-full bg-zinc-950 px-5 py-2 text-sm font-medium text-white transition hover:bg-zinc-900 active:scale-[0.98]"
            >
              Get started
            </Link>
            <Link href="/login" className="text-sm text-zinc-600 transition hover:text-zinc-900">
              Log in
            </Link>
          </div>
        </div>
      </InView>

      <InView delay={0.05} className="mx-auto mt-10 max-w-5xl px-4 sm:mt-14 md:mt-16">
        <div className="rounded-xl border border-zinc-950/10 bg-white/80 p-5 shadow-[0_1px_1px_rgba(0,0,0,0.01)] backdrop-blur-sm sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-950/10 bg-zinc-50/80 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">New kit</div>
                  <div className="mt-1 text-sm font-medium text-zinc-900">Backend Engineer · Acme Inc</div>
                </div>
                <div className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                  Draft
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {["Overview", "Requirements", "Questions", "Flashcards", "Practice", "Schedule"].map((t) => (
                  <div key={t} className="rounded-full border border-zinc-950/10 px-2 py-0.5 text-[11px] text-zinc-500">
                    {t}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-950/10 bg-white p-4">
              <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Questions</div>
              <div className="mt-2 text-sm text-zinc-900">12 across 4 categories</div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-zinc-500">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">Technical · 5</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">Behavioural · 3</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">System design · 2</span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5">Company fit · 2</span>
              </div>
            </div>
          </div>
        </div>
      </InView>

      <section className="mx-auto mt-12 max-w-5xl px-4 sm:mt-16 md:mt-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <InView delay={0.05} className="rounded-xl border border-zinc-950/10 bg-white p-5">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 1</div>
            <h3 className="mt-1 text-base font-medium text-zinc-900">Paste a JD</h3>
            <p className="mt-1 text-sm text-zinc-600">Upload a PDF/DOCX or paste the job description directly.</p>
          </InView>
          <InView delay={0.1} className="rounded-xl border border-zinc-950/10 bg-white p-5">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 2</div>
            <h3 className="mt-1 text-base font-medium text-zinc-900">We research the company</h3>
            <p className="mt-1 text-sm text-zinc-600">Crawl the company site and find public interview-process discussion.</p>
          </InView>
          <InView delay={0.15} className="rounded-xl border border-zinc-950/10 bg-white p-5">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Step 3</div>
            <h3 className="mt-1 text-base font-medium text-zinc-900">Practice a scheduled plan</h3>
            <p className="mt-1 text-sm text-zinc-600">Get requirements, questions, flashcards and a day-by-day schedule.</p>
          </InView>
        </div>
      </section>

      <footer className="mx-auto mt-16 max-w-5xl px-4 py-8 text-center text-xs text-zinc-500">
        <a href="https://github.com/anomalyco/prepWithJD" target="_blank" rel="noopener noreferrer" className="transition hover:text-zinc-900">
          GitHub
        </a>
      </footer>
    </main>
  );
}
# prepWithJD — AI Interview Prep Kit

Users paste a job description, a company URL, and how many prep days they have. The app
crawls the company's site, searches public discussion of its interview process, and
generates a structured prep kit: company brief, role breakdown, categorized question
bank, flashcards, and a day-by-day schedule. Users can then edit / add / delete / reorder /
regenerate any section and practice against the flashcards.

## Project Overview and Tech Stack

- **Web**: Next.js (App Router) + Tailwind CSS — `apps/web`. Client components live in
  `src/components/` (`kit-workspace.tsx` drives kit creation; `kit-detail.tsx` is the
  tabbed builder). A same-origin `/api/*` rewrite in `next.config.ts` proxies every API
  call to Express, so the browser never talks to Mongo or the pipeline directly. Because
  pipeline LLM calls run 1–2 minutes, `experimental.proxyTimeout = 600_000` is set in
  `next.config.ts` to stop the dev proxy killing the proxied request after its 30s default.
  `src/proxy.ts` (Next 16's renamed middleware) does a cheap cookie-presence guard and
  redirects to `/login` before React mounts.
- **API**: Express + TypeScript — `apps/api`. `"type": "module"`, runs TS directly via
  `tsx` (`"start": "tsx src/index.ts"`, no build step, so `dev` and `start` are identical).
  `src/config.ts` owns all env config; `src/routes/kits.ts` is the only door between the
  web app and the pipeline; `src/routes/auth.ts` handles session auth.
- **Persistence**: MongoDB via Mongoose. `packages/pipeline/src/persistence/models/kit.model.ts`
  mirrors the pinned output contract field-for-field as sub-schemas; also `user.model.ts`,
  `session.model.ts` (TTL-indexed), and `sourceFailure.model.ts` for per-source crawl failures.
- **Monorepo**: npm workspaces over `apps/*` + `packages/*`. `packages/pipeline` is the
  shared engine, consumed by **both** the web API and the batch CLI. That split is forced
  by the spec's Section 9 requirement: the batch command must run *the same code, not a
  parallel implementation*. The CLI (`apps/cli`) is a thin argument parser over
  `pipeline.evaluate()`, which calls `runPipeline()` per case — identical to the web path.
- **Language/version**: TypeScript everywhere; root `package.json` `engines.node >= 20.19.0`.

## Setup Instructions

### Local

```bash
git clone <repo>
npm install
cp apps/api/.env.example apps/api/.env    # fill in MONGODB_URI + TAVILY/GROQ keys
cp apps/web/.env.example apps/web/.env    # API_URL=http://localhost:4000
npm run dev                                # API on :4000, web on :3000
```

Environment variables (`apps/api/.env`, read from `src/config.ts` and
`packages/pipeline/src/llm/config.ts`):

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Required. MongoDB Atlas connection string (`connectDb` retries 5× at startup). |
| `GROQ_API_KEY` | Required for any LLM work. `callLLM()` fails with a typed `LLM_API_KEY_MISSING` if absent. |
| `TAVILY_API_KEY` | Optional. Public interview-process search; missing key → honest `SEARCH_API_KEY_MISSING` failure, run still completes. |
| `LLM_FALLBACK=1` | Switches the model from `openai/gpt-oss-120b` to `openai/gpt-oss-20b` (quota relief valve). |
| `LLM_MODEL=...` | Overrides both of the above with an explicit model id. |
| `SESSION_NAME` / `SESSION_TTL_DAYS` | Defaults `sid` / `7`. |
| `API_PORT` / `PORT` | `API_PORT` (default 4000); `PORT` is honored as a fallback for Render's dynamic port. |
| `NODE_ENV` | `development` locally; `production` in deployment (turns on secure cookies + SSRF hardening). |
| `ALLOW_PRIVATE_URLS` | Local-dev only, lets the batch CLI crawl the localhost fixture site. |

Useful commands: `npm run typecheck` (tsc across all workspaces), `npm run smoke`
(crawler against `npm run fixture`'s local fixture site), and the verify scripts under
`tooling/` (`verify-llm`, `verify-extraction`, `verify-coverage`, `verify-scheduling`,
`verify-generation`, `verify-validation`, `verify-search`, `e2e`).

### Deployed

- **API** on Render: deploy from the **repo root** (not `apps/api`, because the workspace
  dep `@prepwithjd/pipeline` only resolves from the root). Build: `npm ci`; Start:
  `npm run start -w @prepwithjd/api`. Keep dev deps (`tsx` etc.) — there is no build step.
  Env: `MONGODB_URI`, `GROQ_API_KEY` (required), `TAVILY_API_KEY` / `LLM_FALLBACK` /
  `LLM_MODEL` optional; leave `NODE_ENV=production` for Secure cookies. Live at
  `https://prepwithjd.onrender.com`.
- **Web** on Vercel: root directory `apps/web`, default `next build`, env
  `API_URL=https://prepwithjd.onrender.com`. Live at `https://prep-with-jd-web.vercel.app`.
- **DB** on MongoDB Atlas (free cluster).

### Batch command (the same code, not a parallel implementation)

```bash
npm run evaluate -- --input <cases.json> --output <kits.json>
```

`apps/cli/src/index.ts` just parses `--input`/`--output`, reads the cases, and calls
`@prepwithjd/pipeline`'s `evaluate()`. Output is the exact Appendix B shape
`{ version, generated_at, kits: [{ id, status: "ok"|"failed", kit, error }] }`; one failed
case never aborts the batch.

## LLM Provider and Model

Every Groq call goes through one package: `packages/pipeline/src/llm/client.ts`
(`callLLM()`) against Groq's OpenAI-compatible `https://api.groq.com/openai/v1` endpoint.
The model name lives in exactly one constant, `LLM_MODEL` in `llm/config.ts`:

- Default: **`openai/gpt-oss-120b`**
- `LLM_FALLBACK=1` → **`openai/gpt-oss-20b`**
- `LLM_MODEL=custom/model` → overrides both (explicit user choice wins)

This was hit for real during development: Groq's free tier exhausted the ~200K tokens/day
quota on the 120b model mid-session. The pipeline doesn't crash — `callLLM()` surfaces a
typed `PipelineError` (`LLM_RATE_LIMITED` / `LLM_HTTP_ERROR`), the orchestrator records it
as a structured `stage_errors` entry (log-and-continue), and the kit is still produced with
honest gaps; setting `LLM_FALLBACK=1` keeps the same session working on the smaller model.

Outbound pacing is controlled by two constants in the same file — `OUTBOUND_RATE = 130`
tokens/s and `OUTBOUND_BURST = 100` — used by the shared limiter described below.

## High-Level Architecture

```
Browser (Next.js origin)
   │  cookie-presence guard (proxy.ts) + same-origin /api rewrite (next.config.ts)
   ▼
Express API (apps/api)  ── routes/kits.ts is the ONLY door the web app
   │                      talks to the pipeline through (auth + kits routes)
   ▼
packages/pipeline  ── runRetrieval / runPipeline / evaluate  (shared engine)
   │
   ▼
MongoDB Atlas (Mongoose models: Kit, User, Session, SourceFailure)

Batch CLI (apps/cli ── npm run evaluate) ──► pipeline.evaluate()  (same code path)
```

The browser never touches Mongo or the network directly. Express holds Mongo access,
sessions, and the pipeline; Next is a thin authenticated proxy. `cors` is configured with
an explicit allowlist (`https://prep-with-jd-web.vercel.app`, `http://localhost:3000`) and
`credentials: true`; `cookieOptions` in `src/config.ts` switches cookies between
`SameSite=Lax` non-secure (local) and `SameSite=None` + `Secure` (production) for the
cross-site Vercel→Render setup.

## Retrieval Approach and Sources Used

`runRetrieval()` → `crawlSite()` (`retrieval/crawler.ts`):

- **BFS crawler, host-agnostic**: starts from the homepage and follows same-origin links
  up to `maxDepth` (default 2) / `maxPages` (default 10). `extractInternalLinks()` resolves
  relative anchors and drops asset extensions (`svg|png|pdf|css|js|...`); `rankInternalLinks()`
  scores candidate links by keyword affinity in the **link text** (strongest) then URL path
  against a vocabulary (`careers|jobs|hiring|recruit` = high; `culture|engineering|blog|about` =
  medium), keeping zero-score links as low-priority fallbacks so unknown sites still get
  crawled. No hardcoded path list anywhere.
- **robots.txt as a first-class module** (`retrieval/robots.ts`): `loadRobots()` fetches and
  parses it into user-agent groups; `RobotsRules.isAllowed()` implements longest-rule-wins
  with Allow-breaks-ties, and `matchingRule()` reports *which* directive blocked a page —
  that winning rule (e.g. `Disallow: /private`) is recorded on the kit in
  `source.robots_blocked[].rule`, so a robots skip is distinguishable from "nobody linked
  here". The site's `Crawl-delay` is honored between fetches (`waitForGap()`).
- **SSRF guard** (`retrieval/guard.ts`): `checkUrl()` rejects non-http(s) schemes, embedded
  credentials, non-standard ports, and (in production) private/loopback IPv4 blocks, IPv6
  unique-local/link-local, `localhost`/`.local`/`.internal`. `fetchPage()` re-runs the check
  on the **final URL after redirects** (`REDIRECT_REJECTED`).
- **Content-type/size allowlist** (`retrieval/fetcher.ts`): only `text/html` and
  `application/xhtml+xml` are accepted (robots.txt additionally allows `text/plain`);
  `maxBytes` defaults to 3 MB and is enforced both via `content-length` and while streaming
  the body.
- **One shared rate limiter for all outbound API calls**: `sharedRateLimitedQueue()`
  (`retrieval/rateLimit.ts`) is a module-level singleton token bucket. It paces **both**
  Tavily search and every Groq LLM call — search charges a flat 1 token, each LLM call
  charges its estimated token cost (`ceil(chars/4)`) — under the single `OUTBOUND_RATE`
  constant. This was a deliberate single-limiter design: free-tier TPM/TPD limits are
  respected *globally*, not per-feature. If code ever requests a divergent rate, the
  singleton keeps the first rate and logs a loud warning so nobody accidentally creates a
  second limiter. Same-origin crawled page fetches are additionally bounded by the robots
  Crawl-delay and the BFS page/depth caps.
- **Public discussion via Tavily** `searchInterviewProcess()` / `searchWeb()`
  (`retrieval/search.ts`): free-tier key (1000 credits/mo), query
  `"{company}" interview process culture hiring`, results (title/url/snippet) stored under
  `source.discussion`. A missing/invalid key returns an honest empty result plus a
  `SEARCH_API_KEY_MISSING`/`SEARCH_API_FAILED` record — never fabricated hits.
- **Log-and-continue**: every failed fetch, robots rejection, or search miss is a structured
  `RetrievalFailure` (`code`, `stage`, `source_url`, `occurred_at`) that is aggregated and
  persisted via `recordSourceFailures` (SourceFailure model) and surfaces on the kit as
  `source.failures` / `stage_errors`. One bad source never aborts a run.

## Research and Generation Sequencing

`runPipeline()` (`packages/pipeline/src/index.ts`) orchestrates, in this exact order:

**retrieval → extraction → per-category question generation → coverage check → gap
second-pass → scheduling → validation**

- **What is deliberately pure code (no model) vs. what really needs the LLM**: The spec's
  Section 3 direction was explicit that coverage and scheduling are *not* handed to the
  model. Both are pure, deterministic functions (`computeUncovered`,
  `buildSchedule`) with zero LLM. Requirement extraction and question generation genuinely
  need the model: `LlmExtractor.extractRequirements()` and `LlmGenerator`.
- **Four separate per-category LLM calls, not one mega-prompt** (`generation/index.ts`):
  `generateCategory()` is invoked once each for `technical`, `behavioural`, `system-design`,
  `company-fit`, each with `categoryCallSchema(category)` strict JSON output (9 schemas
  total per category call incl. flashcards). Retrieved hiring-process context actively
  shapes which questions get written: crawled pages whose title/first text matches the
  `INTERVIEW_SIGNAL` regex (`interview|hiring|recruit|round|onboarding|careers`) become
  `interviewPages`, Tavily hits become `discussion`, and both are injected via
  `interviewContextCtx()` as `<untrusted_context>`. Example: a company engineering blog
  that mentions a take-home or a system-design round steers that category; `system-design`
  itself is told to return an empty list unless the role/context justifies it
  (`CATEGORY_NOTES`).
- **Flashcards are generated inside the same per-category call** (`categoryCallSchema`
  returns both `questions` and `flashcards`), not via a separate LLM call — a deliberate
  token-budget decision under Groq's free-tier TPM/TPD. `generateFlashcards()` only
  materializes if called standalone, and even then derives deterministic cards from
  question prompts/outlines.
- **Requirement dedup by text hash**: `normalizeRequirements()` lowercases each
  requirement's text and dedupes with `hash()` (a deterministic FNV-style string hash) so
  near-duplicate phrasings collapse into one id; `assignStableIds()` then yields
  contiguous `r1..rN` regardless of what the model returned.
- **`sanityCheckPriority()`** (`extraction/index.ts`): a best-effort, log-only check that
  flags when an extracted `must`/`nice` looks inconsistent with the requirement's own wording
  (`MUSTY`/`NICEY` regexes). It is intentionally advisory, not a gate — a heuristic mismatch
  isn't proof of an extraction error, so it only `console.warn`s.
- **Anti-fabrication principle**: company research is used as a *signal* to steer question
  generation, never as license to invent facts not in the JD or retrieved pages. The
  extraction system prompt forbids implied/industry-standard requirements ("don't add Git
  just because it's a backend role"), explicitly blesses empty results, and `coverageGaps()`
  reports honestly when input is thin — a two-line JD yields a thin, honest kit, never
  padding. Post-generation, every `requirement_ids` is validated against the real extracted
  set and dangling references are dropped loudly.

## Coverage Loop

`computeUncovered()` (`coverage/index.ts`) is pure code: it diffs the `must`-priority
requirement ids against the set of ids actually referenced by generated questions and
returns the sorted gap list. After first-draft generation, `LlmGenerator.generateSet()`
runs the check; if gaps exist it issues a single `generateGapBatch()` call targeting
**only** those gap ids (one batched call, not per-requirement), merges, and re-checks. The
loop is capped at **2 total passes**: a second pass catches systematic category misses,
while further gap passes on the free tier burn tokens for marginal recall and tend to
reproduce the same miss pattern against the same context (reasoning documented in code).
Honest leftovers after the cap stay listed in `coverage.uncovered_requirement_ids`; total
passes are recorded in `coverage.passes`.

## Schedule Allocation

`buildSchedule()` (`scheduling/index.ts`) — pure, deterministic, no LLM. Inputs:
`requirements`, `questions`, `daysAvailable` (1–60, both extremes handled).

- `sortByScheduleOrder()`: must-linked questions before nice-only, then difficulty
  descending, then id ascending — a fully deterministic order.
- **Adaptive per-day target**: `adaptiveTargetMinutes = max(ceil(totalMinutes / days), MIN_DAILY_MINUTES)` where `MIN_DAILY_MINUTES = 15`, with **no hard ceiling**. This replaced an
  earlier fixed 90-min/day cap that clustered all material into the first few days no matter
  how many days were requested; now a 60-day plan spreads material across available days
  while a few days + heavy material honestly targets 100+ min/day. Front-loading is kept —
  must/harder questions still land early, they just pack toward the adaptive target.
- **Minutes are a fixed difficulty lookup, explicitly deterministic**: `QUESTION_MINUTES =
  { 1: 10, 2: 15, 3: 20 }` via `minutesForQuestion()`, summed per day — independent of how
  verbose the model's `answer_outline` happens to be, matching the brief's "integer minutes,
  no floats" rule (and fixing an earlier bug where minutes were `ceil(outline_words/40)`).
- Output always has exactly `days_available` day entries; if material runs out, remaining
  days are honest `"Review / light day"` at 0 minutes — never invented filler.

## Generated/Edited/Pinned State Model (the builder)

- The `edited: true` flag exists as an **add-only** field on questions, flashcards, and
  `company_brief` (Mongoose sub-schema + TypeScript `edited?: boolean`). It is set the
  instant a user edits a field (InlineEdit), adds a manual item, or is already true on
  hand-created items.
- **One endpoint, all builder operations**: `PATCH /api/kits/:id/content`
  (`apps/api/src/routes/kits.ts`) dispatches on a zod `contentPatchSchema`
  discriminated-union of ops: `update-item`, `update-brief`, `add-question`,
  `add-flashcard`, `remove-item`, `reorder-questions`, `practice`,
  `regenerate-brief`, `regenerate-category`, `regenerate-schedule`. The route verifies kit
  ownership (`kit.userId.equals(req.user._id)`), `structuredClone`s the content, applies the
  patch in `applyContentPatch()` (or calls the regen orchestrators), and persists via
  `saveKitContent()`. Manually added items get a stable next id from `nextItemId("q"|"f", …)`
  (max numeric suffix + 1) and `edited: true`.
- **Regeneration never clobbers hand work**: `regenerateCompanyBrief()` re-crawls and
  re-extracts but keeps a hand-edited `summary`; `regenerateQuestionCategory()` re-runs only
  that category's LLM call and keeps `edited:true` questions/cards while replacing untouched
  generated items with fresh ones (new unique q/f ids, `edited:false`);
  `regenerateSchedule()` is pure and keeps `days_available`.
- **Pinned contract**: the base JSON shape is pinned in `specs.md` and mirrored field-for-field
  in `types.ts` and the Mongoose sub-schemas; extension is allowed only by *adding* fields
  (which `edited` and `practice` are), never renaming or removing.

## Validation

`kitContentSchema` (`validation/index.ts`) is the **final gate** before anything is persisted
or written to batch output. It is a hand-written JSON Schema, **not Zod**: zod v4's
pure-ESM-with-top-level-await export clashed with this repo's tsx/esbuild import path
(`ERR_REQUIRE_ASYNC_MODULE`). Instead, the project reuses its own `matchesShape()`/`JsonSchema`
engine from `llm/shape.ts` — the *same* validator that gates Groq strict structured responses —
so the entire codebase shares one schema language with zero new runtime deps.

Flow in `validateOrRepair()`:
1. Validate the full `KitContent`. Pass → done.
2. Fail → if the broken part is a *small, LLM-sourced* substructure (`company_brief`,
   `role.title/seniority/responsibilities`, `source.company`), send **only** those failing
   fields back to the model once (~600 tokens, never the full kit) asking for corrected values.
3. Re-validate: pass → return the repaired kit; fail → typed `PipelineError(VALIDATION_FAILED)`.

`runPipeline()` calls retrieval → extraction → generation → coverage → scheduling →
validation in sequence and never returns a kit that hasn't passed validation, so the API
route and the batch CLI only ever persist/output structurally valid `KitContent`.

## Practice Mode

A flip-card deck mapped to flashcards. Front first; click to reveal the back; rate the card
Low / Medium / High. Ratings persist per card as `{ cardId, confidence, lastSeenAt }` in the
kit's `content.practice` array (add-only field), upserted by `cardId` via the PATCH
`practice` op. A "review lowest confidence first" toggle re-sorts the deck (unreviewed cards
rank first, then low < medium < high, id tiebreak), and a progress readout shows
"8 of 14 reviewed". This three-tier sort was chosen over a full spaced-repetition interval
algorithm as a simpler but still defensible option given the project timeline — the brief
explicitly allows either.

## Security

- **SSRF guard**: `checkUrl()` rejects private/loopback IPv4/IPv6, private hostnames,
  embedded credentials, non-http(s) schemes, and non-standard ports in production, and is
  re-applied to the final URL after redirects (`REDIRECT_REJECTED`).
- **Content-type/size allowlisting** on all fetches before any body is processed.
- **robots.txt compliance**: the crawler only fetches URLs `isAllowed()` approves and
  records the exact matching rule for anything skipped.
- **Prompt-injection defense**: every LLM call that includes untrusted text (JD content,
  crawled pages, search snippets, requirement lists) wraps it in explicit `<untrusted_...>`
  delimiter tags, with the `UNTRUSTED_DATA_BOILERPLATE` system instruction that content
  inside those tags is data to extract from, *never* a source of instructions. This was
  tested by injecting fake instructions ("ignore your instructions", "output exactly X")
  inside fake untrusted content to confirm the model doesn't comply. Defense-in-depth:
  `stripDirectiveEcho()` drops bare all-caps directive echoes (log-and-continue) so an
  evasion that slips through never reaches the UI.
- **Session/traffic hygiene**: httpOnly session cookies (`SameSite=Lax`/`None` depending on
  `NODE_ENV`, `Secure` in production), an explicit CORS allowlist, and auth middleware on
  every kit/route.

## Known Limitations

- **Groq free-tier quota**: the ~200K tokens/day on the primary `gpt-oss-120b` model can be
  exhausted during heavy testing/demo use; `LLM_FALLBACK=1` switches to `gpt-oss-20b`
  mid-session as a workaround. Re-generating the brief or a category at runtime may briefly
  error with an amber notice and the run continues.
- **Render free-tier infra**: the API can cold-start or occasionally 502 on the first request
  after inactivity, or on long (~1–2 min) generation calls; Next's `proxyTimeout` keeps the
  request alive, but free-tier timing isn't guaranteed instant.
- **Reordering** uses up/down arrow controls per item rather than drag-and-drop — chosen for
  reliability under the project's time constraints.
- **Practice confidence** is a simple three-tier sort rather than a full spaced-repetition
  scheduling algorithm.
- **`specs.md`** in the repo root documents the actual development log and the AI-assisted
  prompts used throughout the build, included for transparency per the assessment's AI-use
  disclosure expectations.
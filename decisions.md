# Technical decisions — why we picked each part of the stack

Every choice below is a tradeoff made deliberately for this project's constraints:
a fixed, spec'd stack, a strict output contract, a future batch CLI that must reuse the
web app's exact pipeline, and a rule that research must never fabricate.

## Frontend: Next.js (App Router) + Tailwind CSS

- **Why Next.js, not a Vite/CRA SPA:** the app is auth-gated and data-heavy, but a
  server-rendered shell gives us a cheap cookie-presence guard (`proxy.ts` in Next 16
  terminology) that redirects before React even mounts. App Router gives file-based
  routes for `/login`, `/register`, `/dashboard`, `/kits/[id]` with no router library.
- **Why the `/api` rewrite (next.config.ts `rewrites`):** the browser only ever talks to
  the Next origin; it proxies `/api/*` to Express. This removes CORS entirely, keeps the
  session cookie same-origin, and means the API URL never leaks to the page bundle.
- **Why Tailwind v4:** default with the scaffold, zero config, and utility classes keep
  the five screens small. No component library was added — the spec allows a plain,
  clean UI and that keeps the diff readable.

## Backend: Node.js + Express (TypeScript)

- **Why a separate Express backend instead of Next API routes:** the batch CLI
  (`npm run evaluate`) must reuse the exact same pipeline code. If the pipeline lived in
  Next API routes it would be coupled to Next's request lifecycle and impossible to run
  headlessly from a CLI. A standalone Express service owns all data access and the
  pipeline; Next is a thin authenticated proxy. (The spec offered "justify a unified
  Next API-routes approach" — we justified the split instead.)
- **Why Express 5 over Fastify/NestJs:** Express is the spec'd default, fine for ~12
  routes, and version 5's async error forwarding simplifies handlers. No framework
  ceremony.

## Database: MongoDB via Mongoose

- **Why MongoDB:** the kit document is a nested, deeply structured JSON object pinned
  by a non-negotiable contract. Mongo stores that shape natively with no joins and no
  migration table; the contract IS the schema.
- **Why Mongoose:** gives us typed schemas that mirror the contract field-for-field
  (`packages/pipeline/src/persistence/models/kit.model.ts`), enums for
  `kind`/`priority`/`category`, and timestamps for free. Version 9 runs fine on Node 22.
- **Why separate models, not loose JSON:** contract drift between "what we type" and
  "what we store" would corrupt the output contract. One schema = one source of truth.

## Language: TypeScript everywhere

- **Why TS in the pipeline package specifically:** the retrieval code deals with
  failure records, URL verdicts, robots rules and the output contract. Types here are
  not ceremony — they make the Day-2 generation swap (replacing stub extractor /
  generator / scheduler) a compile-checked exercise rather than a runtime surprise.

## Auth: hand-rolled session auth (decision asked upfront)

- Candidate 1 was custom sessions (chosen), candidate 2 `express-session`, candidate 3
  JWT-in-cookie. Custom sessions won because: the scope is "no roles, no reset, no
  verification", we only need one cookie (`sid`), one `sessions` collection with a TTL
  index, and bcryptjs hashes. Full control, no middleware fighting us, and revocation is
  just `deleteOne`.
- Sessions are stored server-side (opaque 256-bit token → Mongo `expiresAt` TTL). The
  cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production. Expired/invalid sessions
  are deleted and answered with `401`, which the web client turns into a redirect —
  graceful, not a crash.

## Search API: Brave Search API (decision asked upfront)

- Candidates were SerpAPI (~100 free queries/month), Brave (2000 free queries/month),
  Tavily (AI-oriented). Brave won on free quota and a clean JSON API.
- It is only used by the `searchInterviewProcess` function and is optional: a missing
  key records an honest `SEARCH_API_KEY_MISSING` failure instead of fabricating results.
- All outbound research calls go through one shared token-bucket queue
  (`retrieval/rateLimit.ts`) — the same queue will pace LLM calls on Day 2.

## Retrieval design (the Day-1 core)

- **No hardcoded paths:** relevance ranking scores link *text* and URL against a
  keyword vocabulary (careers/jobs/hiring = high; culture/engineering/blog = medium)
  and keeps zero-score links as low-priority fallbacks. Any site can be crawled, which
  is exactly what the locally-served fixture site proves in `npm run smoke`.
- **robots.txt is a first-class module:** parsed into user-agent groups, longest-match
  wins, Allow breaks ties, and Crawl-delay is honoured between requests.
- **Failure is data, not an exception:** the fetcher returns structured failure records
  (`RetrievalFailure`) that get persisted to the `SourceFailure` model. One bad fetch
  never aborts a run; the output contract's honesty rules depend on this.
- **Guard on both ends:** URLs are validated before fetching and re-validated after
  redirects. Private/loopback hosts are rejected in production but allowed during local
  dev so the batch CLI can be tested against a local site.

## Monorepo layout

- npm workspaces keep the pipeline in `packages/pipeline` shared by `apps/api` and the
  future `apps/cli` — one implementation, exported through `runRetrieval`/`runPipeline`/
  `evaluate`. The Day-2 CLI becomes argument-parsing over `evaluate`.
- Web, API and pipeline each own their `package.json`, so the web app never imports the
  pipeline's Node-only modules (server and client bundles stay clean).

## What generation, extraction and scheduling look like today

- `extraction/`, `generation/`, `scheduling/` ship as interfaces plus `NotImplemented*`
  stubs that throw `NOT_IMPLEMENTED`. `runPipeline` therefore fails loudly rather than
  persisting fabricated content. Day 2 replaces the stub classes — the contract,
  models and where each stage plugs in are already fixed.
# prepWithJD — AI Interview Prep Kit

Full-stack assessment. Users paste a job description + company URL + prep days; the app
researches the company and generates a structured interview-prep kit (brief, role
breakdown, question bank, flashcards, study schedule).

## Layout (monorepo)

```
apps/
  api/      Express + TypeScript API (auth, kits, retrieval trigger)
  web/      Next.js (App Router) + Tailwind frontend
packages/
  pipeline/ Shared pipeline: retrieval / extraction / generation / scheduling / persistence
           (reused verbatim by the web API AND the batch CLI)
tooling/
  fixture-site/  Local static site used to test the crawler against a non-hardcoded host
```

## Prerequisites

- Node.js >= 20.19
- MongoDB — dev uses a MongoDB Atlas free cluster (see `apps/api/.env`)

## Setup

```bash
npm install
cp apps/api/.env.example apps/api/.env      # then paste your MONGODB_URI (+ Brave key, optional)
cp apps/web/.env.example apps/web/.env      # defaults are fine
npm run dev                                  # API on :4000, web on :3000
```

## Day-1 commands

```bash
npm run fixture                             # serve tooling/fixture-site on http://localhost:9999
npm run smoke                               # crawl the fixture site, assert robots + ranking behaviour
npm run typecheck                           # tsc across all workspaces
```

## Output contract

Every generated kit conforms to the JSON shape pinned in `specs.md`, mirrored as
TypeScript types in `packages/pipeline/src/types.ts` and as Mongoose sub-schemas in
`packages/pipeline/src/persistence/models/kit.model.ts`.

## Batch CLI (Day 2+)

`npm run evaluate -- --input <cases.json> --output <kits.json>` reuses
`runPipeline`/`evaluate` from `packages/pipeline` — no parallel implementation.
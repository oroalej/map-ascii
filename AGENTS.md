# ASCII Atlas — project guide for coding agents

A generic engine for explorable, ASCII-rendered city maps. Each city gets seamless zoom from its surrounding region down to individual streets, guided tours, and a **year timeline** that shows the city changing over time. Visual inspiration: gcdatlas.com (an ASCII universe with smooth zoom, search, tours, and a time control).

The engine is city-agnostic. Each city is added as a **city pack** (`packages/content/cities/<slug>/`: a `city.json` config plus curated content) and a **city brief** (`docs/cities/<slug>.md`). **Naga City, Camarines Sur, Philippines is the first city** (`docs/cities/naga.md`). The roadmap builds the engine against it.

Read these before doing substantial work:

- `docs/SPEC.md` — product behavior: viewpoint, camera, zoom levels, visual language, interactions, tours, timeline, cities
- `docs/ARCHITECTURE.md` — monorepo layout, renderer pipeline, data model, state, performance budgets
- `docs/DATA.md` — data sources, pipeline steps, schemas, date tagging, licensing/attribution, adding a city
- `docs/ROADMAP.md` — phased plan with tasks and acceptance criteria. **Work phase by phase; do not start a phase until the previous one meets its acceptance criteria.**
- `docs/cities/*.md` — per-city briefs (config, tours, research backlog)

## Stack

- pnpm workspaces monorepo, Node 22.13+ (Vitest 5 requires it). TypeScript is pinned to ~6.0 because typescript-eslint doesn't support 7 yet.
- Workspace packages are consumed as TS source (`exports` → `./src/index.ts`), with no build step. Next transpiles them via `transpilePackages`.
- `apps/web`: Next.js (App Router) + TypeScript (strict), static export, deploy to Vercel
- `packages/renderer`: custom WebGL2 ASCII renderer (twgl.js helpers), framework-agnostic TS
- `packages/data`: TS pipeline scripts + CLI tools (Overpass → osmtogeojson → normalize → tippecanoe → PMTiles)
- `packages/content`: city packs — city config, tours, stories, landmark metadata (JSON/MDX, validated with zod)
- `packages/shared`: shared types and zod schemas
- State: Zustand. Search: MiniSearch. Tile access: `pmtiles` + `@mapbox/vector-tile` + `pbf`. Mercator math: `@math.gl/web-mercator`.
- Tests: Vitest (unit), Playwright (smoke/visual)

## Commands

- `pnpm dev` — run the web app
- `pnpm build` — static export to `apps/web/out`, reusing it when build inputs and exported files are unchanged. `pnpm build:force` requests a fresh build.
- `pnpm data:build [-- --city <slug>]` — run the data pipeline for one city (or all registered cities). For each city it outputs `<city>.pmtiles`, `<city>.meta.json`, and `<city>.search-index.json` (and `<city>.processions.json` when the pack has processions) in `apps/web/public/tiles/`. Downloads are saved in `packages/data/raw/` and reused until replaced. Flags: `--offline` (saved downloads only), `--refresh` (download OSM data again), and `--from <step>`. Step 05 needs tippecanoe, natively or via Docker (`packages/data/README.md`).
- `pnpm data:publish [-- --city <slug>]` / `pnpm data:fetch` — upload a city's generated tiles as a GitHub release and pin them in its `tiles.lock.json` / download the pinned tiles (the web build runs it first). See `docs/DATA.md` §9.
- `pnpm test` / `pnpm test:e2e` (e2e prepares the static export before testing, rebuilding only when needed, and serves it on port 3100; set `E2E_PORT` to use another). Both take filters: `pnpm run test --changed`, `pnpm test:e2e smoke.spec.ts --project=chromium -g "<test name>"`. Use `pnpm run test --changed` explicitly: `pnpm test --changed` can consume the flag instead of passing it to Vitest.
- `pnpm check:budgets` — after `pnpm build`, check initial JS and `<city>.pmtiles` against the budgets in `docs/ARCHITECTURE.md` §8
- `pnpm lint` / `pnpm typecheck` / `pnpm format` (Prettier skips `*.md`)
- `pnpm --filter @atlas/content validate` — validate every city pack against the zod schemas

## Verifying changes

Run the smallest check that covers what changed. CI runs the full suite (lint, typecheck, every unit test, the e2e smoke suite on desktop and, for tests tagged `@mobile`, a Pixel 7) on every PR, so don't repeat it locally.

| Change touches | Run |
| --- | --- |
| Docs / `*.md` only | nothing |
| City pack content | `pnpm --filter @atlas/content validate` |
| `dialogue.json` content | the above + `pnpm --filter @atlas/renderer exec vitest run src/life/dialogue-catalog.test.ts` (dynamic pack reads are not tracked by `--changed`) |
| Package code (`renderer`, `shared`, `data`, `content`) | `pnpm run test --changed` (the Vitest files that depend on uncommitted changes) + `pnpm --filter @atlas/<pkg> typecheck` |
| `apps/web` code | the above + `pnpm --filter @atlas/web typecheck` + `pnpm lint` |
| What the browser shows (renderer output, UI flows, URL state) | the above + only the related e2e test, desktop only: `pnpm test:e2e --project=chromium -g "<test name>"` |

- Run the whole e2e suite (both projects) only when asked.
- Keep e2e a small smoke suite: add a Playwright test only for what unit tests can't see (the static export boots, the map draws, a core flow works end to end). Logic goes in Vitest.
- Keep CI fast: jobs run in parallel and time out at 6 minutes (`.github/workflows/ci.yml`). Feature work proves itself with unit tests, not pixel-level Playwright specs. Vitest runs in `node`; a test file opts into jsdom (`// @vitest-environment jsdom`) only when it needs the DOM.
- Build preparation compares content hashes for runtime code, city packs, public assets, build configuration, dependencies, and build environment/toolchain inputs. Docs, tests, test configuration, and pipeline-only edits do not invalidate the export; regenerated public assets do. Missing or changed export files trigger rebuilding too. The fingerprint is saved only after a successful, stable build.
- E2E checks export freshness before Playwright reuses an existing server (`reuseExistingServer`). When e2e is needed more than once, keep `pnpm --filter @atlas/web serve` running in the background to also avoid server startup. Run tests against the server serving this checkout's `apps/web/out`; use `E2E_PORT` if another app owns the port. `--list` and `--help` do not prepare an export.
- Rerun a failing e2e test with `--last-failed`, not the whole spec.
- Report which checks ran and which were left to CI.

## Conventions

- TypeScript strict everywhere; no `any` without a comment explaining why.
- The renderer package must not import React or Next. The web app consumes it through a small imperative API (`createAtlas(canvas, options)`).
- All geographic data flows through the pipeline — never hand-edit generated tiles. Curated facts (dates, stories, name history) live in the city's pack in `packages/content` and are merged by the pipeline.
- Every shared data shape has a zod schema in `packages/shared`; validate content at build time and fail loudly.
- App state that affects the view (city, lat, lng, zoom, year, tour) is mirrored in the URL. The city is the path (`/<city>`).
- Don't hardcode any city's name, boundary, landmark coordinates, or tile filenames in the renderer or web app. City specifics live in the city pack, and geography is derived from OSM by the pipeline (exposed via `<city>.meta.json`).
- Use the generic term "subdivision" in code and schemas. The UI shows the city's local label (e.g. "barangay").
- Show OSM attribution (and any other source attribution) in the UI at all times. See `docs/DATA.md`.
- Historical claims in content must carry a `source` field. If a date is uncertain, mark `certainty: "circa"` rather than guessing.

## Git

- Several agent sessions (Claude Code, Codex) often edit this working tree at once, so `git status` can show someone else's half-finished edits, sometimes in the files you're changing.
- Continue working when another session has uncommitted edits, including in files needed for your task. Preserve those edits and keep your changes scoped to your task. Concurrent edits alone must not trigger a pause or permission request.
- Before each commit, run `git status` and `git branch`: another session may have switched branches.
- Stage files by explicit path. Never use `git add -A`, `git add .`, or `git commit -a`. If a file you must commit also holds another session's uncommitted edits, ask before committing it.
- Commit messages are gitmoji + conventional commits, lowercase and imperative: `✨ feat(life): …`, `🐛 fix(renderer): …`, `⚡️ perf(web): …`, `📝 docs(roadmap): …`. Match `git log`.

## Handoff plans

Implementation plans live in the gitignored `.plans/` folder of the main checkout. `.plans/README.md` indexes them.

- Each task has one folder, `.plans/<status>/<task>/`, where `<status>` is `todo`, `active`, `paused` or `done`. `handoff.md` is the plan.
- Put every scratch file for the task in its folder: screenshots, capture scripts, logs and patches. Never write to the `.plans/` root or another task's folder. In a separate worktree, still use the main checkout's `.plans/`.
- When you start, move the folder from `todo/` to `active/`. When you finish, move it to `done/`, or to `paused/` if you stopped partway. Update its row in `.plans/README.md` each time.
- Before ending the session, delete every file in the task folder except `handoff.md` and files the handoff marks **keep**. In your report, list what you deleted and what you kept.

## Don'ts

- Don't use Google Maps / Street View imagery or tiles (terms forbid use on non-Google maps).
- Don't present OSM edit history as a city's construction history.
- Don't add a tile server or backend; the site is fully static.

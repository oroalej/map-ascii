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
- `pnpm test:related <files>` — only the Vitest files that depend on the given files (what you work with). `pnpm test` runs every unit test; CI does that.
- `pnpm test:e2e` — prepares the static export (rebuilding only when needed) and serves it on this checkout's own port (`apps/web/scripts/e2e-port.ts`; `E2E_PORT` overrides it). Takes filters: `pnpm test:e2e smoke.spec.ts --project=chromium -g "<test name>"`.
- `pnpm worktree:new <short> <topic>` — create a task worktree `worktrees/<short>` on `codex/<topic>` from the latest `origin/main`, with dependencies and tiles.
- `pnpm plans:clean <task> [--keep <path>]... [--dry-run]` — delete a task's scratch from the main checkout's `.plans/`, keeping `handoff.md` and each `--keep` path (relative to the task folder, nested allowed; a folder that keeps nothing goes too). Works from any worktree. Refuses a linked task folder.
- `pnpm worktree:remove <branch> [--head <sha>] [--dry-run]` — after its PR merges, delete a task's worktree folder and local branch (the remote branch stays). Run it from the main checkout; it refuses an unmerged branch, a different head when `--head` pins the merged PR, uncommitted changes, or protected ignored files. Move protected files such as `packages/data/raw/`, unpublished tiles, `.env*.local`, arbitrary logs and root performance reports to a safe location before worktree removal. Generated caches, pipeline build intermediates, coverage and blob reports are disposable. Completed-task scratch can still be cleaned when protected ignored files defer worktree removal. Rerun it to finish a removal that a busy file interrupted.
- `pnpm cli:latest <codex|claude>`: print the path of the newest installed `codex`/`claude` executable (several copies can be installed, and PATH may pick an old one). Agent skills that start a separate Codex or Claude run that path. From Windows PowerShell, call `pnpm.cmd`, because the execution policy blocks `pnpm.ps1`.
- `pnpm check:budgets` — after `pnpm build`, check initial JS and `<city>.pmtiles` against the budgets in `docs/ARCHITECTURE.md` §8
- `pnpm lint` / `pnpm typecheck` / `pnpm format` (Prettier skips `*.md`)
- `pnpm --filter @atlas/content validate` — validate every city pack against the zod schemas

## Verifying changes

Verification has three stages. Don't run a later stage's checks earlier, and never run the whole unit suite or the whole e2e suite locally: CI runs both on every push to a PR (lint, format, typecheck, every unit test, and the e2e smoke suite on desktop and, for tests tagged `@mobile`, a Pixel 7). Pushes to `main` rerun `check` and refresh shared pnpm and Playwright caches.

**1. While working: targeted tests only.** After each step, run the tests that depend on the files you changed: `pnpm test:related <changed files>`. In your own worktree, `pnpm run test --changed` selects the same (use `pnpm run test`, not `pnpm test`, which can consume the flag). Don't typecheck, lint or build after each step. Content edits count: tests that read city-pack files declare them with `import.meta.glob`, so an edited `dialogue.json` or detail file selects its tests.

**2. Once, at the end of the task, after the targeted tests pass:**

| Change touches | Run once |
| --- | --- |
| Docs / `*.md` only | nothing |
| City pack content | `pnpm --filter @atlas/content validate` |
| Package code (`renderer`, `shared`, `data`, `content`) | `pnpm --filter @atlas/<pkg> typecheck` for each touched package + `pnpm lint` |
| `apps/web` code | the above + `pnpm --filter @atlas/web typecheck` |
| What the browser shows (renderer output, UI flows, URL state) | the above + only the related e2e test, desktop only: `pnpm test:e2e --project=chromium -g "<test name>"` |

If one fails, fix it and rerun only that check.

**3. CI** runs everything on each push to a PR. Pushes to `main` run `check` (lint, format, typecheck, content validation, unit tests) and refresh shared caches; browser smoke tests and export budgets run on PRs only. Report which checks ran locally and which were left to CI.

- **No screenshots or visual evidence.** Don't write capture scripts or browser harnesses, take screenshots, or collect evidence files. The owner reviews visual changes in `pnpm dev`; your report lists the URLs to open (`/<city>?lat=…&lng=…&zoom=…&year=…`).
- **Perf harnesses** (`pnpm perf:*`) run only when the task is about performance. They take the whole machine (below).
- **Keep tests fast; never raise a time limit.** Vitest runs files in parallel and each file serially, so the slowest file sets the suite's wall time. Split a slow file or make it cheaper. ESLint rejects a timeout argument in a test, and CI fails any test file over 30 s (`scripts/test-budget.ts`).
- Keep e2e a small smoke suite: add a Playwright test only for what unit tests can't see (the static export boots, the map draws, a core flow works end to end). Logic goes in Vitest.
- Keep CI fast: on PRs, the e2e shards run in parallel once `check` (lint, format, typecheck, unit tests) passes; `main` runs `check` and shared-cache preparation only. Every job times out at 6 minutes (`.github/workflows/ci.yml`). Feature work proves itself with unit tests, not pixel-level Playwright specs. Vitest runs in `node`; a test file opts into jsdom (`// @vitest-environment jsdom`) only when it needs the DOM.
- **This machine is shared by several sessions.** Locally Vitest uses at most 4 workers; don't pass `--maxWorkers`. Builds, e2e and perf runs wait for one of two machine-wide heavy slots (`scripts/heavy-slot.ts`; perf takes both) and print `waiting for a heavy slot`; let them wait.
- Build preparation compares content hashes for runtime code, city packs, public assets, build configuration, dependencies, and build environment/toolchain inputs. Docs, tests, test configuration, and pipeline-only edits do not invalidate the export; regenerated public assets do. Missing or changed export files trigger rebuilding too. The fingerprint is saved only after a successful, stable build.
- E2E checks export freshness before Playwright reuses an existing server (`reuseExistingServer`). When e2e is needed more than once, keep `pnpm --filter @atlas/web serve` running in the background (it serves on this checkout's port). `--list` and `--help` do not prepare an export.
- Rerun a failing e2e test with `--last-failed`, not the whole spec.

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

- **One worktree per task.** Start a new task with `pnpm worktree:new <short> <topic>` (a worktree `worktrees/<short>` inside the main checkout, on `codex/<topic>` from the latest `origin/main`; `worktrees/` is gitignored). The main checkout stays on `main` and is only for planning and `.plans/`; a pre-commit hook (`.githooks/`, enabled on install) refuses commits there on any other branch. Older worktrees may still sit beside the repo at `../naga-ascii-<short>`, so `git worktree list` is the source of truth.
- Nested worktrees can resolve undeclared imports from the main checkout's `node_modules`; install dependencies in each worktree and keep dependency declarations accurate, with CI's clean install as the backstop.
- New nested worktrees get local Claude settings excluding the main checkout's `CLAUDE.md` and `AGENTS.md`, so Claude reads the task's instructions without the parent's copy. For a manually added or recreated nested worktree, run `pnpm exec tsx scripts/claude-worktree-settings.ts` from it. Cleanup accepts only the pristine generated exclusions; additional personal settings stay protected.
- **Merge with `$merge-pr`.** After the merge it deletes the task's scratch, its local branch and its worktree folder. The remote branch stays.
- If the PR was merged through GitHub or another session, run `$merge-pr <branch>` from the main checkout to finish cleanup. Its already-merged path retains the merged-head, task-completion and keep-inventory safeguards.
- A follow-up to an existing task (an adjustment, fix, review fix, or next phase) continues in that task's worktree and branch. Find them with `git worktree list` and the task's row in `.plans/README.md`. Don't create a new worktree or branch for a follow-up, and don't add suffixes like `-ii`, `-hardening` or `-pause`.
- If `$merge-pr` already removed that task's local branch and worktree, recreate the original branch from its retained `origin/<branch>` and the original worktree path with `git worktree add --track -b <branch> <original-path> origin/<branch>`. If the local branch still exists, reuse it with `git worktree add <original-path> <branch>`. Inside either recreated worktree, run `pnpm install --frozen-lockfile` and `pnpm data:fetch` to restore dependencies and pinned tiles. Continue there without inventing a replacement branch or suffix.
- Before each commit, run `git status` and `git branch`.
- Stage files by explicit path. Never use `git add -A`, `git add .`, or `git commit -a`.
- Commit messages are gitmoji + conventional commits, lowercase and imperative: `✨ feat(life): …`, `🐛 fix(renderer): …`, `⚡️ perf(web): …`, `📝 docs(roadmap): …`. Match `git log`.

## Handoff plans

Implementation plans live in the gitignored `.plans/` folder of the main checkout. `.plans/README.md` indexes them.

- Each task has one folder, `.plans/<status>/<task>/`, where `<status>` is `todo`, `active`, `paused` or `done`. `handoff.md` is the plan.
- In new handoffs, list **keep** entries as exact paths relative to that task folder (files or directories, including nested paths). Counts and prose alone do not identify protected files. Cleanup reconciles legacy keep prose with the README and inventory, verifies a dry-run by file identity and directory coverage, and preserves the whole task when the protected set is ambiguous.
- Put every scratch file for the task in its folder: logs and patches. Never write to the `.plans/` root or another task's folder. In a separate worktree, still use the main checkout's `.plans/`.
- A handoff for a follow-up names the task's existing worktree and branch (from its `.plans/README.md` row), not a new one.
- Confirm each step with targeted tests only; the end-of-task checks run once (see "Verifying changes"). No screenshots or evidence sets.
- When you start, move the folder from `todo/` to `active/`. When you finish, move it to `done/`, or to `paused/` if you stopped partway. Update its row in `.plans/README.md` each time.
- Don't delete scratch yourself. When the PR merges, `$merge-pr` runs `pnpm plans:clean`, keeping `handoff.md` and the files the handoff marks **keep**. Never delete scratch with shell commands (`Remove-Item -Recurse`, `rm -rf`): Codex rejects them as "blocked by policy".

## Don'ts

- Don't use Google Maps / Street View imagery or tiles (terms forbid use on non-Google maps).
- Don't present OSM edit history as a city's construction history.
- Don't add a tile server or backend; the site is fully static.

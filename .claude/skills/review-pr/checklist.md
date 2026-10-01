# Review checklist

Each area lists what to look for in ASCII Atlas. Report only what the diff introduces or makes worse. Skip anything CI already enforces:

- ESLint bans `any`, enforces type-only imports, and blocks React/Next in `packages/renderer`.
- `pnpm typecheck` runs in CI.
- `packages/content/src/no-hardcoding.test.ts` catches city names and slugs in engine source.
- `pnpm check:budgets` checks gzipped JS and pmtiles size.
- `pnpm --filter @atlas/content validate` checks the city packs.

## A. Correctness & robustness

- **Logic:**
  - edge cases: empty, zero, single item, boundaries
  - off-by-one errors
  - null/undefined paths that types don't cover (`!`, `as` casts, unchecked `.get()` / array index)
  - NaN or Infinity reaching geometry or shaders
- **Async and workers:**
  - a reply arriving after the state it belongs to has changed: stale tile, camera, or year
  - messages arriving out of order
  - missing cancellation of fetches, flights, or tour holds
  - the inline fallback path diverging from the worker path
- **Resource lifetime:** every created GL buffer, VAO, texture, framebuffer, query, worker, event listener, `ResizeObserver`, `matchMedia` listener, and rAF has a matching dispose on teardown, tile eviction, and theme/DPR/density rebuild.
- **WebGL context loss:** the new GPU state is recreated after restore. Nothing holds a stale handle.
- **Determinism:**
  - Seeded simulation and procedural output must not use `Math.random`, `Date.now`, `performance.now`, or iteration order over unordered sources.
  - A change to seeded output must be intentional and stated in the PR.
- **URL state:**
  - City, lat, lng, zoom, year, and tour stay mirrored in the URL.
  - Back/Forward restores them without enqueuing a new history entry.
  - Debug-only params stay out of share URLs.
- **Reduced motion:** new animation respects `setReducedMotion` and the media query.
- **Data pipeline:**
  - steps stay idempotent
  - `--offline`, `--refresh`, and `--from <step>` still work
  - generated files are validated against their zod schema when written

## B. Performance & cost

Name the hot path for every finding: per frame, per agent step, per tile, per worker message, initial JS, renderer chunk, pmtiles, or CI time.

- **Per-frame and per-step code:**
  - Allocations inside loops: new arrays/objects, closures, spreads, `map`/`filter` chains, string building, `Map`/`Set` churn.
  - Reuse scratch buffers the way existing code does (ARCHITECTURE §8 describes the reused label grids, collision scratch, and packed upload buffers).
- **Complexity:**
  - O(n²) scans over agents, tiles, or features
  - linear lookups that should go through an index
  - recomputation of something that could be cached, keyed on the inputs ARCHITECTURE §8 lists (tiles, zoom, DPR, cell size, grid origin, theme)
- **GPU:**
  - redundant buffer or texture uploads
  - per-frame `bufferData` where `bufferSubData` or no upload would do
  - extra draw calls or state changes
  - shader work that could move to setup
  - blocking readbacks (`readPixels`, `getQueryParameter` polled synchronously)
- **Workers:**
  - structured-clone size of posted messages
  - typed arrays posted without transfer
  - per-frame posts of static data
  - main-thread work that belongs in the worker
- **Bundle:**
  - new dependencies (check `package.json` diffs)
  - zod or other heavy modules reaching browser code; the browser checks shapes with `apps/web/lib/guards.ts`, and `packages/shared` keeps zod-free modules
  - imports that pull the renderer into initial JS instead of its separate chunk
  - debug UI that isn't lazy-loaded
- **Tiles:** pipeline changes that grow `<city>.pmtiles` (new layers, attributes, or lower min-zooms) against the 40 MB budget.
- **CI cost** (jobs time out at 6 minutes):
  - new Playwright specs that unit tests could cover
  - pixel/screenshot assertions
  - `// @vitest-environment jsdom` on tests that don't touch the DOM
  - long simulated durations or full populations in unit tests (bounded test populations are the norm)
  - new serial CI steps
  - Flag growth even if this PR still passes, and propose a guardrail that would fail CI.

## C. Quality & reuse

- **Reuse:**
  - Before accepting a new helper, Grep for an existing one in `packages/shared/src`, `packages/renderer/src` (camera, grid, density, classes, labels, picking, …), `packages/renderer/src/life`, and `apps/web/lib` (geo, guards, search, tour, motion, dom).
  - Cite the match by `path:line`.
  - Watch for duplicated constants, such as zoom ranges or class lists that `packages/shared` already exports.
- **Duplication:** copy-pasted blocks within the diff, or between the diff and existing code.
- **Dead code:** unused exports, parameters, branches, flags, or leftover debug logging.
- **Types:**
  - `as` casts that hide a real mismatch
  - non-null `!` without a reason
  - wide `string` or `number` where a union or branded type exists
  - `any` (lint blocks it unless it has a comment; check that the comment justifies it)
- **Magic numbers:** tunables that belong in a named constant, config, or the city pack. City-specific values must never live in engine code.
- **Abstraction level:**
  - a new layer, option, or indirection with a single caller
  - one function doing several unrelated jobs
  - a file grown far past its neighbours where a split is natural
- **Consistency:** naming, comment density, error handling, and module structure match the surrounding code.
- **Public API:**
  - unintended changes to `createAtlas(canvas, options)`, `AtlasOptions`, `getStats()`, or other exports of `packages/renderer/src/index.ts`
  - API changes not reflected in ARCHITECTURE §2

## D. Project rules, tests & docs

- **City-agnostic engine:** no coordinates, boundaries, landmark positions, tile filenames, or local labels hardcoded in `packages/renderer` or `apps/web`. They come from the city pack or `<city>.meta.json`. The no-hardcoding test only catches names.
- **Naming:** code and schemas say "subdivision". Only the UI shows the local label (e.g. "barangay").
- **Attribution:** OSM (and any other source) attribution stays visible in every view and state, including the new ones.
- **Content:**
  - Historical claims carry `source`.
  - Uncertain dates use `certainty: "circa"`.
  - OSM edit history is never presented as construction history.
- **Schemas:**
  - Every new shared data shape has a zod schema in `packages/shared`.
  - Content is validated at build time and fails loudly.
- **Architecture limits:**
  - no backend or tile server
  - no Google Maps or Street View imagery
  - generated tiles are never hand-edited
  - all geography flows through the pipeline
- **Tests:**
  - New logic has Vitest coverage in `node` (jsdom only when the DOM is needed).
  - E2E is added only for what unit tests can't see. Mobile-relevant flows are tagged `@mobile`.
  - Tests assert behavior, not implementation details.
  - Seeded tests use fixed seeds.
- **Docs:**
  - Behavior, budgets, API, or pipeline changes are reflected in `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/DATA.md`, `docs/ROADMAP.md`, or the city brief.
  - The PR doesn't start a roadmap phase whose predecessor isn't done.
- **Commits:** gitmoji + conventional, lowercase, and imperative (`✨ feat(scope): …`). Flag commits that mix unrelated changes.

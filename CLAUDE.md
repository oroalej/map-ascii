# Naga Atlas — project guide for Claude Code

An explorable, ASCII-rendered map of **Naga City, Camarines Sur, Philippines** — seamless zoom from the Bicol region down to individual streets, guided tours, and a **year timeline** that shows the city changing over time. Visual inspiration: gcdatlas.com (an ASCII universe with smooth zoom, search, tours, and a time control).

Read these before doing substantial work:

- `docs/SPEC.md` — product behavior: viewpoint, camera modes, zoom levels, visual language, interactions, tours, timeline
- `docs/ARCHITECTURE.md` — monorepo layout, renderer pipeline, data model, state, performance budgets
- `docs/DATA.md` — data sources, pipeline steps, date tagging, licensing/attribution
- `docs/ROADMAP.md` — phased plan with tasks and acceptance criteria. **Work phase by phase; do not start a phase until the previous one meets its acceptance criteria.**

## Stack

- pnpm workspaces monorepo, Node 22.13+ (Vitest 5 requires it). TypeScript is pinned to ~6.0 because typescript-eslint doesn't support 7 yet.
- Workspace packages are consumed as TS source (`exports` → `./src/index.ts`), with no build step. Next transpiles them via `transpilePackages`.
- `apps/web`: Next.js (App Router) + TypeScript (strict), static export, deploy to Vercel
- `packages/renderer`: custom WebGL2 ASCII renderer (twgl.js helpers), framework-agnostic TS
- `packages/data`: TS pipeline scripts + CLI tools (Overpass → osmtogeojson → normalize → tippecanoe → PMTiles)
- `packages/content`: tours, stories, landmark metadata (JSON/MDX, validated with zod)
- `packages/shared`: shared types and zod schemas
- State: Zustand. Search: MiniSearch. Tile access: `pmtiles` + `@mapbox/vector-tile` + `pbf`. Mercator math: `@math.gl/web-mercator`.
- Tests: Vitest (unit), Playwright (smoke/visual)

## Commands

- `pnpm dev` — run the web app
- `pnpm build` — static export to `apps/web/out`
- `pnpm data:build` — run the full data pipeline, output `apps/web/public/tiles/naga.pmtiles` and `search-index.json`
- `pnpm test` / `pnpm test:e2e` (e2e builds the static export and serves it on port 3100)
- `pnpm lint` / `pnpm typecheck` / `pnpm format` (Prettier skips `*.md`)
- `pnpm --filter @naga/content validate` — validate curated content against the zod schemas

## Conventions

- TypeScript strict everywhere; no `any` without a comment explaining why.
- The renderer package must not import React or Next. The web app consumes it through a small imperative API (`createAtlas(canvas, options)`).
- All geographic data flows through the pipeline — never hand-edit generated tiles. Curated facts (dates, stories, name history) live in `packages/content` and are merged by the pipeline.
- Every shared data shape has a zod schema in `packages/shared`; validate content at build time and fail loudly.
- App state that affects the view (lat, lng, zoom, pitch, bearing, year, tour) is mirrored in the URL.
- Don't hardcode the city boundary or landmark coordinates; derive them from OSM in the pipeline.
- Show OSM attribution (and any other source attribution) in the UI at all times. See `docs/DATA.md`.
- Historical claims in content must carry a `source` field. If a date is uncertain, mark `certainty: "circa"` rather than guessing.

## Don'ts

- Don't use Google Maps / Street View imagery or tiles (terms forbid use on non-Google maps).
- Don't present OSM edit history as the city's construction history.
- Don't add a tile server or backend; the site is fully static.

# ASCII Atlas

![ASCII Atlas: Naga City zooming from the region down to living streets, day into night](docs/media/demo.avif)

An engine for explorable, ASCII-rendered city maps. Each city zooms seamlessly from its surrounding region down to individual streets, with guided tours and a year timeline that shows the city changing over time.

**First city:** Naga City, Camarines Sur, Philippines ([`docs/cities/naga.md`](docs/cities/naga.md)). More cities are added as city packs; see [`docs/DATA.md`](docs/DATA.md) §8, "Adding a city".

> Status: see the phases and the log in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Prerequisites

- Node 22.13+ (see `.nvmrc`)
- pnpm 9 (`corepack enable` picks up the version from `package.json`)

## Commands

| Command | Does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Run the web app at http://localhost:3000 |
| `pnpm build` / `pnpm build:force` | Reuse or rebuild the static export in `apps/web/out` / explicitly force a fresh build |
| `pnpm data:build` | Run the data pipeline (tiles, meta, and search index per city; `-- --city <slug>` for one city) |
| `pnpm data:publish` / `pnpm data:fetch` | Upload a city's tiles as a GitHub release and pin them in its `tiles.lock.json` / download the pinned tiles (`docs/DATA.md` §9) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Prepare the export only when needed, then run Playwright smoke tests (install Chromium once with `pnpm --filter @atlas/web exec playwright install chromium`) |
| `pnpm demo:video` | Render the README clip (`docs/media/demo.avif`) frame by frame from the static export; needs ffmpeg |
| `pnpm check:budgets` | After `pnpm build`, check initial JS and tile sizes against the budgets |
| `pnpm --filter @atlas/content validate` | Validate every city pack |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm format` | Prettier |

Working with coding agents (Claude Code, Codex): see [`AGENTS.md`](AGENTS.md).

## Layout

```
apps/web            Next.js (App Router, static export), one route per city
packages/renderer   WebGL2 ASCII renderer (framework-agnostic, city-agnostic)
packages/data       Data pipeline: OSM → PMTiles, per city
packages/content    City packs: config, landmarks, events, name history, tours
packages/shared     zod schemas and shared types
```

## Docs

- [`docs/SPEC.md`](docs/SPEC.md): product behavior
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): renderer pipeline, data model, state
- [`docs/DATA.md`](docs/DATA.md): sources, pipeline, licensing, adding a city
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md): Vercel setup, preview checks, production and rollback
- [`docs/ROADMAP.md`](docs/ROADMAP.md): phased plan
- [`docs/cities/`](docs/cities/): per-city briefs ([Naga](docs/cities/naga.md))

## Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the ODbL.

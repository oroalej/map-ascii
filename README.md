# ASCII Atlas

An engine for explorable, ASCII-rendered city maps. Each city zooms seamlessly from its surrounding region down to individual streets, with guided tours and a year timeline that shows the city changing over time.

**First city:** Naga City, Camarines Sur, Philippines ([`docs/cities/naga.md`](docs/cities/naga.md)). More cities are added as city packs; see [`docs/DATA.md`](docs/DATA.md) §8, "Adding a city".

> Status: Phase 0 (scaffold). See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Prerequisites

- Node 22.13+ (see `.nvmrc`)
- pnpm 9 (`corepack enable` picks up the version from `package.json`)

## Commands

| Command | Does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Run the web app at http://localhost:3000 |
| `pnpm build` | Static export of the web app to `apps/web/out` |
| `pnpm data:build` | Run the data pipeline (tiles, meta, and search index per city; `-- --city <slug>` from Phase 1) |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm test:e2e` | Smoke tests (Playwright; run `pnpm --filter @atlas/web exec playwright install chromium` once) |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript |
| `pnpm format` | Prettier |

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
- [`docs/ROADMAP.md`](docs/ROADMAP.md): phased plan
- [`docs/cities/`](docs/cities/): per-city briefs ([Naga](docs/cities/naga.md))

## Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the ODbL.

# Roadmap — ASCII Atlas

ASCII Atlas is a generic engine for ASCII city maps. **Naga City is the first city.** Phases 1–6 build the engine using Naga as the working example, and Phase 7 proves the engine is generic by onboarding a second city. Naga-specific tasks and acceptance criteria are marked **(Naga)**. Details are in [`docs/cities/naga.md`](cities/naga.md).

Work phase by phase. Each phase ends with its acceptance criteria met, tests green, and a short note appended to the "Log" at the bottom of this file.

## Phase 0 — Scaffold

**Tasks**
- [x] pnpm workspace with `apps/web` and `packages/{renderer,data,content,shared}`; shared `tsconfig.base.json` (strict).
- [x] Next.js App Router app with `output: 'export'`, a full-screen canvas page, and a dark theme.
- [x] ESLint and Prettier; Vitest and Playwright configured; root scripts `dev`, `data:build`, `test`, `test:e2e`, `lint`, `typecheck`.
- [x] zod schemas in `packages/shared` for Landmark, NameHistory, Event, Tour, and CameraState.
- [x] CI (GitHub Actions) running lint, typecheck, and unit tests.

**Accept when**
- `pnpm dev` shows a blank dark canvas.
- All scripts run without error.
- CI is green.

## Phase 1 — Generic foundation + Naga Centro prototype (prove the look)

**Tasks**
- [x] `City` zod schema in `packages/shared`. Switch `LocalizedText` to "`en` + the city's declared languages" (`DATA.md` §4).
- [x] City pack layout: move content under `packages/content/cities/<slug>/`, and add `cities/naga/city.json` **(Naga)**. The validator walks every city pack.
- [ ] Pipeline takes `--city` (default: all registered cities), and writes `raw/<city>/`, `build/<city>/`, `<city>.pmtiles`, and `<city>.meta.json`.
- [ ] Web app reads the city's meta for bounds and default camera. Remove the hardcoded Naga camera from the store, the hardcoded tiles URL, and the hardcoded canvas `aria-label`.
- [ ] Data pipeline steps 01–05 for the Naga detail bbox only (no Region layers yet). Output `naga.pmtiles` **(Naga)**.
- [ ] Renderer:
  - [ ] tile loading in a worker
  - [ ] cell pass (class and id buffers)
  - [ ] glyph atlas
  - [ ] glyph pass
  - [ ] road connectivity LUT
  - [ ] water animation
- [ ] Map camera: pan, zoom anchored at the cursor, min/max zoom, bounds.
- [ ] Theme file with the classes from `SPEC.md` §4.
- [ ] Attribution line.

**Accept when**
- **(Naga)** The Centro renders as recognizable ASCII at z14–z18: the river, major roads with correct box-drawing junctions, and buildings.
- No city names, coordinates, or tile filenames are hardcoded in `packages/renderer` or `apps/web` (grep check). City specifics come only from the city pack and the generated meta.
- 60 fps pan and zoom on desktop.
- Unit tests cover the glyph LUT and camera math.

## Phase 2 — Whole city and core UX

**Tasks**
- [ ] Region layers (coastline, major roads, water, DEM terrain ramp) and zoom-level crossfades.
- [ ] Label placement with collision; subdivision and street names.
- [ ] Picking (hover highlight, click select), plus the info panel populated from OSM tags and content.
- [ ] Search (pipeline step 06 → `<city>.search-index.json`, MiniSearch, `/` shortcut, fly-to).
- [ ] `app/[city]/` route with static params from the city registry. `/` redirects client-side to the only city.
- [ ] Fly-to animation; URL state sync; share button; HUD (scale, subdivision with the city's local label, coordinates).
- [ ] Mobile gestures and bottom-sheet panel; reduced-motion support.
- [ ] **(Naga)** Seed content: 10 landmarks with sources (see `docs/cities/naga.md` §4).

**Accept when**
- Zooming from the Region level to a single building is smooth.
- **(Naga)** Searching "Cathedral" flies to the Naga Metropolitan Cathedral and opens the panel.
- A shared URL (`/<city>?…`) reproduces the view.
- The Playwright smoke tests pass.

## Phase 3 — Orbit, 3D buildings, tours

**Tasks**
- [ ] Orbit mode: pitch/bearing input, extruded building meshes, face shading → glyph ramp, compass reset.
- [ ] Tour schema and player (caption card, controls, progress, pause on camera grab, "Resume tour" chip).
- [ ] Tours live in the city pack (`cities/<slug>/tours/`).
- [ ] **(Naga)** Tours: "From Isarog to the river" and "Heritage Centro walk" (narration marked `TODO(verify)` until sourced).

**Accept when**
- **(Naga)** Tilting to 60° shows the Centro skyline in ASCII.
- Both tours play end to end on desktop and mobile.

## Phase 4 — Timeline v1

**Tasks**
- [ ] Timeline slider UI with data-driven ticks (range from the city's meta `yearRange`), play/pause, and a large year indicator; year in the URL.
- [ ] Renderer time filtering (`u_year`), type-in/dissolve transition masks, and dithering for `circa` dates.
- [ ] `name_history` resolution in labels.
- [ ] Imagery underlay: the pipeline bakes grayscale tiles per city (`imagery/<city>/`) for selected years (Sentinel-2 or Esri Wayback, whichever the licensing allows), and the renderer samples the underlay luminance.
- [ ] Events layer and pins.
- [ ] Legend note about undated features.

**Accept when**
- **(Naga)** Scrubbing from 2015 to the current year visibly changes the underlay.
- Dated landmarks appear and disappear at the right years.
- Unit tests cover the visibility logic.

## Phase 5 — Historical depth

**Tasks**
- [ ] Georeferenced historic map underlays (`cities/<slug>/historic-maps`) with year ranges.
- [ ] Standalone geometry for demolished landmarks.
- [ ] "Then/now" photo pairs in the info panel.
- [ ] UI string translations keyed by language code, loaded per city's declared languages.
- [ ] **(Naga)** Street renaming data for the Centro.
- [ ] **(Naga)** "Traslación route" and "Campus belt" tours, including year-setting steps.
- [ ] **(Naga)** `fil` and `bcl` translations for UI strings and the main landmarks.

**Accept when**
- **(Naga)** At least one pre-2000 era has a coherent historical underlay plus dated features.
- Every historical claim shows its sources.

## Phase 6 — Street walk mode

**Tasks**
- [ ] Road graph built from OSM in the pipeline (nodes and edges with names), shipped as a compact binary.
- [ ] Walk camera: snap to the nearest edge, move with WASD/arrows, choose branches at junctions, low eye-level pitch.
- [ ] Pseudo-3D rendering along the road, with building facades on both sides.

**Accept when**
- **(Naga)** A visitor can walk from the Basilica to the Cathedral along real streets at ≥30 fps on mobile.

## Phase 7 — Second city

**Tasks**
- [ ] Choose the second city (see Open decisions), and write its brief at `docs/cities/<slug>.md`.
- [ ] Onboard it with a city pack only, following `DATA.md` §8 "Adding a city": `city.json`, the smoke landmark, and one establishing tour.
- [ ] Make `/` a city picker in the same ASCII style, and add a way to switch cities from inside the atlas.
- [ ] Fix any city-specific assumptions the second city exposes in the engine, e.g. admin levels, languages, scripts in the glyph atlas, or southern-hemisphere or antimeridian bounds.

**Accept when**
- The second city builds, validates, and passes the e2e smoke test.
- Adding it needed no changes in `packages/renderer` or `apps/web` except the generic fixes listed above.
- Both cities share one static deploy, and share URLs for either city round-trip.

## Open decisions

- Pure ASCII vs hybrid. Default: hybrid (photos and panels render normally).
- Which imagery source is allowed for the timeline underlay. This must be settled before Phase 4.
- Hosting for large tile and imagery files: Vercel or R2.
- Final product name ("ASCII Atlas" is the working name) and domain name.
- How to assign subdivisions when a city's subdivision boundaries are incomplete in OSM (Naga: 3 of 27 barangays mapped). Options: leave features without a subdivision, derive approximate areas from `place` nodes (and label them approximate), or map the boundaries in OSM from a license-compatible source. Must be settled before step 03 computes `subdivision`.
- Which city comes second. It should differ from Naga in at least one of country, admin levels, or languages, to stress the generic model.

## Log

<!-- Append one short entry per completed phase: date, what shipped, known issues. -->

- **2026-09-29 — Phase 0 (scaffold).** pnpm monorepo (`apps/web`, `packages/{renderer,data,content,shared}`); Next 16 static export showing a blank dark WebGL2 canvas with OSM attribution; renderer `createAtlas` stub; zod schemas for Landmark, NameHistory, Event, Tour, CameraState; content validator; pipeline step stubs; ESLint/Prettier/Vitest/Playwright; GitHub Actions CI. Known: Node 22.13+ required (Vitest 5), TypeScript pinned to ~6.0 (typescript-eslint), CI green pending first push.
- **2026-09-29 — Renamed to ASCII Atlas.** Docs made city-generic with Naga City as the first city (`docs/cities/naga.md`); package scope renamed `@naga/*` → `@atlas/*`, root package `ascii-atlas`, product name in UI strings.

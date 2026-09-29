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
- [x] Pipeline takes `--city` (default: all registered cities), and writes `raw/<city>/`, `build/<city>/`, `<city>.pmtiles`, and `<city>.meta.json`.
- [x] Web app reads the city's meta for bounds and default camera. Remove the hardcoded Naga camera from the store, the hardcoded tiles URL, and the hardcoded canvas `aria-label`.
- [x] Data pipeline steps 01–05 for the Naga detail bbox only (no Region layers yet). Output `naga.pmtiles` **(Naga)**.
- [x] Renderer:
  - [x] tile loading in a worker
  - [x] cell pass (class and id buffers)
  - [x] glyph atlas
  - [x] glyph pass
  - [x] road connectivity LUT
  - [x] water animation
- [x] Map camera: pan, zoom anchored at the cursor, min/max zoom, bounds.
- [x] Theme file with the classes from `SPEC.md` §4.
- [x] Attribution line.

**Accept when**
- **(Naga)** The Centro renders as recognizable ASCII at z14–z18: the river, major roads with correct box-drawing junctions, and buildings.
- No city names, coordinates, or tile filenames are hardcoded in `packages/renderer` or `apps/web` (grep check). City specifics come only from the city pack and the generated meta.
- 60 fps pan and zoom on desktop.
- Unit tests cover the glyph LUT and camera math.

## Phase 2 — Whole city and core UX

**Tasks**
- [ ] Region layers (coastline, major roads, water, DEM terrain ramp) and zoom-level crossfades.
- [ ] Label placement with collision; subdivision and street names. *(Started early: placement, collision, and landmark/monument names are in; subdivision and street names remain.)*
- [ ] Picking (hover highlight, click select), plus the info panel populated from OSM tags and content.
- [ ] Search (pipeline step 06 → `<city>.search-index.json`, MiniSearch, `/` shortcut, fly-to).
- [ ] `app/[city]/` route with static params from the city registry. `/` redirects client-side to the only city.
- [ ] Fly-to animation; URL state sync; share button; HUD (scale, subdivision with the city's local label, coordinates).
- [ ] Mobile gestures and bottom-sheet panel; reduced-motion support.
- [ ] Zoom-out limit: the minimum zoom is the one that fits the city's `regionBounds` in the viewport (recomputed on resize), and the view stays over the region.
- [ ] Top-right corner: a legend of what each glyph means, listing the classes visible at the current zoom (derived from the theme, never hardcoded).
- [ ] Top-right corner: the current zoom value and its level name (e.g. `z 15.3 · District`).
- [ ] **(Naga)** Seed content: 10 landmarks with sources (see `docs/cities/naga.md` §4).

**Accept when**
- Zooming from the Region level to a single building is smooth.
- **(Naga)** Searching "Cathedral" flies to the Naga Metropolitan Cathedral and opens the panel.
- A shared URL (`/<city>?…`) reproduces the view.
- The Playwright smoke tests pass.
- Zooming out stops at the view that fits the whole region.
- The legend lists what is on screen, and the zoom readout tracks the camera.

## Phase 3 — Orbit, 3D buildings, tours

**Tasks**
- [ ] Orbit mode: pitch/bearing input, extruded building meshes, face shading → glyph ramp, compass reset. *(Started early: right-drag / Ctrl+drag / two-finger twist, extrusions with shaded walls and solid roofs, and the compass reset are in; the skyline acceptance check is still to do.)*
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
- ~~How to assign subdivisions when a city's subdivision boundaries are incomplete in OSM.~~ **Settled in Phase 2:** mapped boundaries win; elsewhere, features get the nearest subdivision `place` node inside the city (Voronoi areas clipped to the city boundary), flagged `approximate`. The UI marks these with "≈", and approximate borders are never drawn. Mapping the real boundaries in OSM remains the long-term fix.
- Which city comes second. It should differ from Naga in at least one of country, admin levels, or languages, to stress the generic model.

## Log

<!-- Append one short entry per completed phase: date, what shipped, known issues. -->

- **2026-09-29 — Phase 0 (scaffold).** pnpm monorepo (`apps/web`, `packages/{renderer,data,content,shared}`); Next 16 static export showing a blank dark WebGL2 canvas with OSM attribution; renderer `createAtlas` stub; zod schemas for Landmark, NameHistory, Event, Tour, CameraState; content validator; pipeline step stubs; ESLint/Prettier/Vitest/Playwright; GitHub Actions CI. Known: Node 22.13+ required (Vitest 5), TypeScript pinned to ~6.0 (typescript-eslint), CI green pending first push.
- **2026-09-29 — Renamed to ASCII Atlas.** Docs made city-generic with Naga City as the first city (`docs/cities/naga.md`); package scope renamed `@naga/*` → `@atlas/*`, root package `ascii-atlas`, product name in UI strings.
- **2026-09-29 — Phase 1 (generic foundation + Naga Centro prototype).** WebGL2 ASCII renderer in `packages/renderer`: a tile worker (PMTiles range requests → vector-tile decode → earcut, Int16 tile-local positions), a cell pass with MRT class/attribute/id buffers and depth-based class priority, a select pass (road connectivity LUT, water animation, building ramp, area patterns), and a full-screen glyph pass over a canvas-generated glyph atlas (box-drawing and block glyphs drawn as shapes so lines join). Map camera with drag, cursor-anchored wheel and pinch zoom, keyboard `+`/`-`/arrows, zoom 7–19, and region bounds. Theme with the `SPEC.md` §4 classes. The pipeline now gives heights only to features with `building=*`, so school/church/market grounds render as `░` under their buildings. Tests: glyph LUT and rules, glyph atlas, camera math, tile selection and cache, tile geometry, a no-hardcoded-city guard, and an e2e check that the canvas draws. Measured 60 fps pan/zoom on a GTX 1650 SUPER. Known: labels, admin outlines, picking, and fly-to are Phase 2; `setYear` is still a stub (Phase 4); e2e port is overridable with `E2E_PORT`.
- **2026-09-29 — Place-level detail (early Phase 2 work).** Zooming in now adds detail: curated landmark names from z16 and monument names from z18 (greedy placement with collision and halos, a first cut of the Phase 2 label system); double-line walls on landmark buildings and borders on landmark plazas from z17; single-line walls on every building from z18 (traced from the id buffer, with correct concave corners); statues, memorials, and monuments (`▲`, new `monument` class) from z17 via per-class minimum zoom; `landuse=religious` grounds rendered as ground. The Overpass cache is now keyed by query, so changing a query re-downloads. Still 60 fps at z19 on a GTX 1650 SUPER. Known: zoom-level changes pop rather than crossfade.
- **2026-09-29 — Deeper detail up close.** Zoom now reaches z21. Place level adds: roads as real-width strips with curbs (z18), roof texture (z19), trees, fences, entrances, and street furniture from OSM, and hand-drawn landmark ASCII art (11 drafts: the Metropolitan Cathedral, San Francisco Parish, the Quince Martires and Rizal monuments, three Cathedral Grounds statues, the Robredo Coliseum, the Archbishop's Residence, USI, and Naga Parochial School) placed by footprint size with names underneath. Orbit mode (from Phase 3) is in: right-drag tilts and rotates, buildings extrude with shaded walls, and a compass resets the view. Known: the art is draft until reviewed; the Freedom Monument is an OSM plaque with no reference photo, so it has no drawing; patterns are screen-anchored while tilted.
- **2026-09-29 — Top-down only.** The front-view landmark drawings made the map mix perspectives, so they came off the map (kept in the city pack for the Phase 2 info panel). Instead, pitched roofs show a ridge and lit/shaded slopes (z19+, from each footprint's long axis), and landmarks get plan-view parts from the city pack's `plans/`: the Cathedral's belfries, crossing dome, and cupolas; San Francisco Parish's dome and tower; the Quince Martires and Rizal monuments' tiered bases; the Coliseum's crown; the Cathedral Grounds statues' pedestals. All plans are drafts. Known: generic ridges follow the principal axis, so L-shaped roofs get one straight ridge.

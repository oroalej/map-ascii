# Roadmap — Naga Atlas

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

## Phase 1 — Centro prototype (prove the look)

**Tasks**
- [ ] Data pipeline steps 01–05 for the Naga detail bbox only (no Region layers yet). Output `naga.pmtiles`.
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
- The Centro renders as recognizable ASCII at z14–z18: the river, major roads with correct box-drawing junctions, and buildings.
- 60 fps pan and zoom on desktop.
- Unit tests cover the glyph LUT and camera math.

## Phase 2 — Whole city and core UX

**Tasks**
- [ ] Region layers (coastline, major roads, water, DEM terrain ramp) and zoom-level crossfades.
- [ ] Label placement with collision; barangay and street names.
- [ ] Picking (hover highlight, click select), plus the info panel populated from OSM tags and content.
- [ ] Search (pipeline step 06, MiniSearch, `/` shortcut, fly-to).
- [ ] Fly-to animation; URL state sync; share button; HUD (scale, barangay, coordinates).
- [ ] Mobile gestures and bottom-sheet panel; reduced-motion support.
- [ ] Seed content: 10 landmarks with sources (see `DATA.md` §7).

**Accept when**
- Zooming from the Region level to a single building is smooth.
- Searching "Cathedral" flies to it and opens the panel.
- A shared URL reproduces the view.
- The Playwright smoke tests pass.

## Phase 3 — Orbit, 3D buildings, tours

**Tasks**
- [ ] Orbit mode: pitch/bearing input, extruded building meshes, face shading → glyph ramp, compass reset.
- [ ] Tour schema and player (caption card, controls, progress, pause on camera grab, "Resume tour" chip).
- [ ] Tours: "From Isarog to the river" and "Heritage Centro walk" (narration marked `TODO(verify)` until sourced).

**Accept when**
- Tilting to 60° shows the Centro skyline in ASCII.
- Both tours play end to end on desktop and mobile.

## Phase 4 — Timeline v1

**Tasks**
- [ ] Timeline slider UI with data-driven ticks, play/pause, and a large year indicator; year in the URL.
- [ ] Renderer time filtering (`u_year`), type-in/dissolve transition masks, and dithering for `circa` dates.
- [ ] `name_history` resolution in labels.
- [ ] Imagery underlay: the pipeline bakes grayscale tiles for selected years (Sentinel-2 or Esri Wayback, whichever the licensing allows), and the renderer samples the underlay luminance.
- [ ] Events layer and pins.
- [ ] Legend note about undated features.

**Accept when**
- Scrubbing from 2015 to the current year visibly changes the underlay.
- Dated landmarks appear and disappear at the right years.
- Unit tests cover the visibility logic.

## Phase 5 — Historical depth

**Tasks**
- [ ] Georeferenced historic map underlays (`content/historic-maps`) with year ranges.
- [ ] Standalone geometry for demolished landmarks.
- [ ] Street renaming data for the Centro.
- [ ] "Then/now" photo pairs in the info panel.
- [ ] "Traslación route" and "Campus belt" tours, including year-setting steps.
- [ ] `fil` and `bcl` translations for UI strings and the main landmarks.

**Accept when**
- At least one pre-2000 era has a coherent historical underlay plus dated features.
- Every historical claim shows its sources.

## Phase 6 — Street walk mode

**Tasks**
- [ ] Road graph built from OSM in the pipeline (nodes and edges with names), shipped as a compact binary.
- [ ] Walk camera: snap to the nearest edge, move with WASD/arrows, choose branches at junctions, low eye-level pitch.
- [ ] Pseudo-3D rendering along the road, with building facades on both sides.

**Accept when**
- A visitor can walk from the Basilica to the Cathedral along real streets at ≥30 fps on mobile.

## Open decisions

- Pure ASCII vs hybrid. Default: hybrid (photos and panels render normally).
- Which imagery source is allowed for the timeline underlay. This must be settled before Phase 4.
- Hosting for large tile and imagery files: Vercel or R2.
- Domain name.

## Log

<!-- Append one short entry per completed phase: date, what shipped, known issues. -->

- **2026-09-29 — Phase 0 (scaffold).** pnpm monorepo (`apps/web`, `packages/{renderer,data,content,shared}`); Next 16 static export showing a blank dark WebGL2 canvas with OSM attribution; renderer `createAtlas` stub; zod schemas for Landmark, NameHistory, Event, Tour, CameraState; content validator; pipeline step stubs; ESLint/Prettier/Vitest/Playwright; GitHub Actions CI. Known: Node 22.13+ required (Vitest 5), TypeScript pinned to ~6.0 (typescript-eslint), CI green pending first push.

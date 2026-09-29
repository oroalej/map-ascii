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
- [x] Region layers (coastline, major roads, water, DEM terrain ramp) and zoom-level crossfades.
- [x] Label placement with collision; subdivision and street names.
- [x] Picking (hover highlight, click select), plus the info panel populated from OSM tags and content.
- [x] Search (pipeline step 06 → `<city>.search-index.json`, MiniSearch, `/` shortcut, fly-to).
- [x] `app/[city]/` route with static params from the city registry. `/` redirects client-side to the only city.
- [x] Fly-to animation; URL state sync; share button; HUD (scale, subdivision with the city's local label, coordinates).
- [x] Mobile gestures and bottom-sheet panel; reduced-motion support.
- [x] Zoom-out limit: the minimum zoom is the one that fits the city's `regionBounds` in the viewport (recomputed on resize), and the view stays over the region.
- [x] Top-right corner: a legend of what each glyph means, listing the classes visible at the current zoom (derived from the theme, never hardcoded).
- [x] Top-right corner: the current zoom value and its level name (e.g. `z 15.3 · District`).
- [x] **(Naga)** Seed content: 10 landmarks with sources (see `docs/cities/naga.md` §4).

**Accept when**
- Zooming from the Region level to a single building is smooth.
- **(Naga)** Searching "Cathedral" flies to the Naga Metropolitan Cathedral and opens the panel.
- A shared URL (`/<city>?…`) reproduces the view.
- The Playwright smoke tests pass.
- Zooming out stops at the view that fits the whole region.
- The legend lists what is on screen, and the zoom readout tracks the camera.

## Phase 3 — Orbit, 3D buildings, tours

**Tasks**
- [x] Orbit mode: pitch/bearing input, extruded building meshes, face shading → glyph ramp, compass reset. Tilted views thin out their labels so the skyline shows.
- [x] Tour schema and player (caption card, controls, progress, pause on camera grab, "Resume tour" chip).
- [x] Tours live in the city pack (`cities/<slug>/tours/`).
- [x] **(Naga)** Tours: "From Isarog to the river" and "Heritage Centro walk" (narration marked `TODO(verify)` until sourced). "From Isarog to the river" was removed when the map was limited to downtown; it comes back when the map extends past it.
- [x] Landmark appearance pass, done together with the skyline check: review the draft `plans/` and `art/`, and tune how plan-view parts read when tilted. Checked tilted at z17.5–19: the parts sit and rise where their plans put them, so no numbers changed. Plans and art stay `draft` until someone who knows the places reviews them.

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

## Side quest — Living city

Built alongside Phase 3 to make the map feel inhabited (SPEC.md §4 "Life layer").

**Tasks**
- [x] Life geometry from the tiles (road, path, plaza, and river lines; bird roosts).
- [x] Simulation: vehicles, people, boats, and bird flocks, with junctions, zoom bands, time-of-day activity, and a draw cap.
- [x] Life pass and glyph-pass drawing, with agents kept to the cells that allow them.
- [x] Day/night from the real sun (or a fixed day, dusk, or night): tint, lit windows, streetlights, headlights.
- [x] HUD "Life" toggle and time chip, remembered in the browser; off with reduced motion.
- [x] Vehicle kinds (car, motorcycle, tricycle, jeepney, bus, truck, bicycle) with paints, drawn at real size from top-down plans when zoomed in; each city's mix in its pack's `traffic`.
- [x] Boats (rowboat, motorboat, banca) drawn the same way; vehicles and boats queue instead of overlapping; parked vehicles in parking lots and along wide roads' curbs.
- [x] River processions from city packs (pipeline step 07): pagoda, voyadores, escorts, crowds, and candles; played from the HUD or live on schedule. Naga's Peñafrancia fluvial procession is a draft: its route start, direction, and schedule need sources.

**Accept when**
- **(Naga)** At z17+ over the Centro, cars follow the streets through junctions, people stroll the plazas, boats drift on the Naga River, and birds circle the parks.
- Turning Life off removes every agent, and reduced motion never shows any.
- 60 fps pan with Life on, on desktop hardware. *(Still to check by hand; headless runs use software WebGL.)*

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

- Pure ASCII vs hybrid. Default: hybrid (photos and panels render normally). **Settled for the map (2026-09-29):** the map stays ASCII, and its legibility limits are fixed inside the engine (two colors per cell, sub-cell edges; SPEC.md §4) rather than by moving to a 3D library such as Three.js, which would replace none of the ASCII pipeline. A non-ASCII 3D view is still possible outside the map (e.g. a landmark model in the info panel), and Phase 6 street walk gets a spike before its renderer is chosen.
- Which imagery source is allowed for the timeline underlay. This must be settled before Phase 4.
- Hosting for large tile and imagery files: Vercel or R2. **Settled for tiles for now:** each city's generated files are GitHub release assets pinned by its `tiles.lock.json`, fetched before every build and served by Vercel as static files (`DATA.md` §9). Revisit (R2) when imagery underlays arrive in Phase 4.
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
- **2026-09-29 — Phase 2 (whole city and core UX).** Region layers are drawn (sea, coastline, DEM terrain ramp `. : - = + * # %`, city and mapped barangay boundaries, place names by level), and every class crossfades at its `CLASS_ZOOM` band edges by a per-cell dither instead of popping. Region-only features are tiled only to z11 (`REGION_TILE_MAX_ZOOM`) and drawn from their z11 tile when the view is deeper, which took `naga.pmtiles` to 7.1 MB and the tile build from over 25 minutes to a few. Streams and canals are their own class (`water_stream`, from z12.5), and rivers start at the City level. Street names follow their street (along it within 20° of horizontal, down it within 20° of vertical, else beside it), one per stretch. Picking reads one id-buffer texel per frame; hover brightens, and the selection takes the accent color with a shimmer. Flights follow van Wijk and Nuij's zoom-and-pan path (0.8–3 s). Zooming out stops where the region fills the view. Web: `/<city>` routes (static params), `/` redirects to the only city, and the view is mirrored in the URL (camera replaced, debounced; selection pushed, so Back works). Also: search (`/`, grouped results, fly-to, selection, and street highlights); the info panel, a bottom sheet on phones, showing the landmark's draft front-view art; the HUD (zoom and level, a legend built from the theme, scale bar, subdivision with "≈" when approximate, coordinates, share); and DEM attribution. Seed landmark 10: Peñafrancia Basilica. Tests: 242 unit, and 16 Playwright tests on desktop and mobile (Pixel 7) covering the redirect, drawing, search, click-to-panel, the HUD and legend, URL mirroring, and share-URL round-trips. Checked by screenshot: the region view fits at z7.3 and shows the peninsula's relief; the City and Street levels read correctly. Still to check by hand: frame rate and smoothness from Region to a single building on real hardware (headless tests use software WebGL). Known: hover picking uses a synchronous `readPixels`, which stalls the GPU once per pointer move (an async PBO readback would fix it); rivers look stippled at the City level; labels switch at band edges rather than fading; the legend lists what the zoom can show, not only what is in view.
- **2026-09-29 — Post–Phase 2 hardening.** The Phase 2 known issues are fixed. Picking and the new legend readback are asynchronous (`readback.ts`: `readPixels` into a pixel-pack buffer, fenced, read a frame or two later), so hover no longer stalls the GPU. The legend lists only the classes on screen (`classeschange`). Labels fade with the same half-level dither as classes, keeping their box while they fade. Rivers at the City level are continuous: every line vertex also claims its cell (GL_LINES skipped segments inside one cell), and thin river and stream runs draw as `( )` down the screen and `╱ ╲` on diagonals instead of trails of `~`. Also: the renderer recovers from a lost WebGL context (rebuilds GPU state, fetches tiles again; "Restoring the map…" meanwhile); `index.ts` is split into `passes`, `tile-cache`, `gpu-context`, `flight`, and `readback`; a hidden-until-focused "Places in view" list gives keyboard and screen-reader users the named places on screen (`labelschange`); `?debug=1` shows fps, frame and cell-pass times, tiles, and decode time (`getStats()`). Infrastructure: tiles are published as GitHub releases and pinned per city (`pnpm data:publish` / `pnpm data:fetch`, the web build fetches them); CI validates content, and a new e2e job fetches tiles, runs Playwright, and checks size budgets (`pnpm check:budgets`). Initial JS went from 324 KB to 232 KB gzipped (budget 250 KB): zod stays out of the browser (the pipeline validates generated files when it writes them, and the web app only checks their shape, `lib/guards.ts`; plain values like the class list and camera ranges moved to zod-free `constants.ts` and `search-options.ts`), and MiniSearch loads with the search index. Naga's tiles are published (`tiles-naga-20260929-1207`). Tests: 293 unit, and 20 Playwright tests per project (desktop and Pixel 7). Known: frame rate on real hardware (and a mid-range Android) is still to check by hand with `?debug=1`.
- **2026-09-29 — Phase 3 (orbit, 3D buildings, tours).** Tours: the `Tour` schema gains `status` (draft or verified; a verified tour has no `TODO(verify)` and cites sources on every step), per-step `sources`, and `fly_ms` (up to 15 s), and `select`/`highlight` take feature ids. The player is a pure reducer (`apps/web/lib/tour.ts`: fly, hold, advance) behind a small store: a Tours menu (`T`), a caption card with prev/pause/next/exit and a progress bar, `Space` and `Esc`, and a "Resume tour" chip when the visitor moves the map or selects something else (the renderer's new `input` event); a hidden tab pauses too. A tour start is one history entry, and `?tour=&step=` reopens it paused. On phones the card is a bottom sheet in place of the info panel. Pipeline step 04 fails if a tour selects or highlights a missing feature or leaves the region. Naga: "Heritage Centro walk" (draft, narration `TODO(verify)`); "From Isarog to the river" was written and tested, then removed when the map was limited to downtown. Orbit: at 60° over the Centro, street and small-place names keep to the nearer part of the screen, so the far half shows extruded buildings; the skyline was accepted by screenshot. E2E plays every tour end to end (fake clock) on desktop and a Pixel 7, steps through with the controls, pauses on a drag, reopens from a shared URL, and checks the 60° view; the drawn-map checks now hide the HUD so its text can't pass for glyphs. Known: plan parts are small at z17–18; names with Roman-numeral characters (e.g. "Ocampo Ⅱ Street") draw `?` because the glyph atlas lacks them; software WebGL in headless tests can come up blank with 6+ pages at once, so screenshots for review are taken serially.
- **2026-09-29 — Side quest: Living city.** The map is inhabited. Simulated vehicles (`▬ ▮`, by heading on screen), people (`☺`), boats (`◊`), and bird flocks (`v -`) move at real-world speeds along OSM geometry already in the tiles: the worker emits road, path, plaza, and river polylines and bird roosts per tile (`life/geometry.ts`), and a pure simulation (`life/simulate.ts`, seeded per tile) moves them through junctions or U-turns at dead ends. A life pass puts them on a per-cell texture each frame, and the glyph pass draws them only where the map allows (vehicles on roads, boats on water, people off roofs and water; hidden behind buildings when tilted). Day/night: the map is lit for the real sun over the view (`life/sun.ts`), or a fixed day, dusk, or night; night dims toward blue with lit windows, streetlights, and headlights, and thins the crowds; birds roost after dusk. HUD: a "Life" toggle and a time chip (localStorage, not the URL); reduced motion disables the agents. The legend lists the agents as "(simulated)". `?debug=1` shows the agent count; e2e runs pin the time of day to day (`playwright.config.ts`). Tests: unit tests for the sun, simulation, packing, life geometry, and legend, and 3 Playwright tests per project (agents appear and turn off and stay off, the time chip cycles and is remembered, reduced motion shows none). Densities were doubled after a first look (a car every 30 m of major road, a stroller every 10 m of plaza edge; up to 1,200 agents drawn). Known: fixed times of day are daylight levels, not clock hours; agents respawn when the view crosses an integer tile zoom; the 60 fps check with Life on is still to do on real hardware.
- **2026-09-29 — Legibility pass.** Buildings and small features were hard to read at cell resolution, which raised migrating to Three.js; the map stays ASCII instead (see Open decisions). Each cell now has two colors: areas tint their cells' background with a faint fill of their class color (`ClassStyle.fill`), so footprints read as shapes and road strips get a surface. Flat views also rasterize the ground at 2 × 3 samples per cell, and cells on an area's edge draw the sextant of the part inside it over the neighbor's fill, so edges and diagonals step by a sixth of a cell. Tests: unit tests for the sextant glyphs and their atlas shapes, the fill and sextant tables, and the edge rule. Checked by screenshot (day, Centro, z14–18.5 and 60° tilt). Known: the sub-cell draw doubles the flat cell pass's ground work; its cost on real hardware and a mid-range phone is still to check with `?debug=1`; e2e was not rerun.
- **2026-09-29 — Denser map.** The legibility pass wasn't enough, so the map's characters now shrink as the camera zooms in (`density.ts`: 8 CSS px wide below z13, 7, 6, then 5 from z16.5, with hysteresis at the step edges), up to 4× the cells of the old fixed 10×18. Labels stay 10×18 on their own grid and atlas. Walls, road strips, and roof ridges follow a detail zoom (one level per halving of the cell width), so at z17.5 every building is outlined and streets are real-width strips with curbs. Shade blocks lose their pixel gap below 8 px. Tests: the schedule, hysteresis, detail zoom, and the map/label glyph split. Checked by screenshot (day, Centro, z14 / 16 / 17.5 / 19, and 60° tilt). Known: the grid pops when zoom crosses a step; the tilted view's flat roofs have no outlines, so neighboring buildings merge in 3D; the palette pass is still to do; the frame rate at 5 px cells on real hardware and phones is still to check with `?debug=1`; e2e not rerun.
- **2026-09-29 — Wind on the grass, truer trees.** Parks and a new `grass` class (`landuse=grass|meadow|village_green`, `natural=grassland`, `leisure=recreation_ground`, now fetched) sway in the wind: gust fronts from the northeast, bent by value noise and blowing in drifting patches, lean the blades `/` or `\` and flatten them `~` (`windGust`, off with reduced motion). Height-less grounds (campuses, church grounds) now draw under the grass, parks, and water on them, which is where most of Naga's lawns are. Woods are clumped crowns with small clearings instead of a per-cell scatter. Trees get a kind (`variant`: palm from taxonomy tags, else `leaf_type`), drawn `Ψ` / `↑` / `♣`, and a `height` and `crown` from OSM or typical values; the renderer draws each tree's crown as wide as it is (a crown every crown's width along tree rows), and in the tilted view stands it on a `│` trunk. Sub-cell edges use a per-class array, since the new `tree_crown` class's id is past 31. Tests: the pipeline's grass and tree rules, wind, grass and canopy glyphs, crowns, trunks, tree rows, and draw order; 386 unit and 38 e2e. Checked by screenshot (day: parks at z18.5 in two frames, the Ateneo campus lawns, crowns at z20, 60° tilt). Naga's tiles are rebuilt, not published. After review, trees move too: crowns are lumpy, slightly oval shapes seeded by each tree's id instead of circles, and their branches swing. Crowns moved out of the cell pass into a crown layer, redrawn every animated frame over a copy of the rest (`crownPass`), so each crown vertex swings downwind with the gust at its spot (tips most) and the ground shows where it swung from. Their leaves flutter `% &`, woods lean their canopy pattern downwind, and grass bent by a gust catches the light. Known: Naga's 36 mapped trees carry no species or size tags, so they all draw as default broadleaf crowns; gusts and the canopy follow screen cells in tilted views, as water does.
- **2026-09-29 — A living map: wind, weather, shadows, birds.** The wind is live state: it follows the city pack's new `climate` by month (Naga: amihan from the NE Nov–Mar, habagat from the SW Jun–Sep, light easterlies between; PAGASA), veers ±25° and breathes in strength, and moves grass, trees, woods, fields (a new `crop` kind: rows lean, furrows ripple), and water (gust bands). A HUD Wind chip shows the direction and cycles live / calm / breeze / gusty / storm; a storm brings rain (slanted streaks over a dimmed map). Buildings, trees, and crowns cast shadows from the real sun (`solarPosition` now gives the azimuth), or the fixed day's and dusk's, in flat views. Birds land in trees (tree points are perches) and a strong gust flushes them. Polish: labels spell out `Ⅱ` as `II` and search matches it (NFKD), tilted roofs get rims so neighbors read apart, and `?debug=1` shows the crown pass's time. Tests: 471 unit. Checked by screenshot (storm and rain, dusk shadows, the Wind chip, birds perched in the Robredo roundabout's trees, Ocampo II Street, tilted rims). Known: shadows are subtle on the dark theme's near-black ground; the rain has no splashes on water yet; tilted views show no shadows (their 3D is enough); tiles are rebuilt (search index) but not published.

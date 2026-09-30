# Architecture — ASCII Atlas

The engine is city-agnostic. Everything specific to a city lives in its city pack (`packages/content/cities/<slug>/`) or is derived from OSM by the pipeline. Examples below use Naga, the first city.

## 1. Repository layout

```
ascii-atlas/
├─ AGENTS.md                  guide for coding agents (CLAUDE.md imports it)
├─ docs/                      SPEC, ARCHITECTURE, DATA, ROADMAP
│  └─ cities/                 one brief per city (naga.md, …)
├─ package.json               root scripts (dev, data:build, test, lint, typecheck)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ apps/
│  └─ web/                    Next.js App Router, static export
│     ├─ app/                 layout, global styles, `/` landing (redirect or city picker)
│     │  └─ [city]/           per-city page, static params from the city registry
│     ├─ components/          CityAtlas, AtlasCanvas, SearchBox, InfoPanel, Hud, Timeline, TourPlayer
│     ├─ state/               Zustand store + URL sync
│     └─ public/tiles/        per city: <city>.pmtiles, <city>.meta.json,
│                             <city>.search-index.json, imagery/<city>/ (all generated)
├─ packages/
│  ├─ renderer/               WebGL2 ASCII engine (no React)
│  │  └─ src/
│  │     ├─ index.ts          createAtlas() public API
│  │     ├─ camera.ts         camera state, projection, fly-to, bounds
│  │     ├─ input.ts          pointer/touch/keyboard → camera intents
│  │     ├─ tiles.ts          PMTiles fetch, decode, LRU cache, tile selection
│  │     ├─ raster/           feature → cell-buffer rasterization (per tile)
│  │     ├─ glyphs/           glyph atlas generation, glyph selection rules
│  │     ├─ shaders/          cell pass, glyph pass, composite
│  │     ├─ labels.ts         placement + collision on the cell grid
│  │     ├─ picking.ts        pointer → cell, highlight states (id readback is in index.ts)
│  │     ├─ legend.ts         legend entries from the theme and zoom bands
│  │     ├─ time.ts           year filtering + transition masks
│  │     └─ theme.ts          glyph + color definitions per class
│  ├─ data/                   pipeline (Node scripts + CLI tools)
│  │  ├─ scripts/             01-fetch, 02-convert, 03-normalize, 04-merge-content, 05-tiles, 06-search-index
│  │  └─ raw/<city>/, build/<city>/   gitignored
│  ├─ content/                curated knowledge, one city pack per city
│  │  └─ cities/<slug>/
│  │     ├─ city.json         city config (boundary lookup, region, subdivision level + label, languages)
│  │     ├─ landmarks/*.json
│  │     ├─ events/*.json
│  │     ├─ name-history/*.json
│  │     ├─ tours/*.json
│  │     ├─ plans/*.json, art/*.json   landmark plan-view parts, front-view art
│  │     ├─ landcover/*.json   trees, grass, parking OSM doesn't map yet, traced from imagery (dropped as OSM catches up)
│  │     ├─ historic-maps/*.json
│  │     └─ media/            photos (or references to external hosting)
│  └─ shared/                 zod schemas + TS types
```

## 2. Renderer public API

```ts
// meta = the city's <city>.meta.json, emitted by the pipeline
const atlas = createAtlas(canvas, {
  tilesUrl: `/tiles/${city}.pmtiles`,      // e.g. /tiles/naga.pmtiles
  theme: 'dark',
  cells: DEFAULT_CELLS,   // map cell width by zoom (density.ts); labels: labelCell, 10×18
  bounds: meta.regionBounds,
  initialCamera: urlCamera ?? meta.defaultCamera,
  year: 2026,
});

atlas.setCamera(partial, { animate?: boolean, duration?: number });
atlas.flyTo(target: Partial<CameraState>, { duration?: number });  // duration overrides 0.8–3 s
atlas.getCamera(): CameraState;
atlas.setYear(year: number, { animate?: boolean });
atlas.setTheme('dark' | 'light');
atlas.setSelected(featureId | null);
atlas.setHighlighted(featureIds: string[]);          // at most 64, e.g. a street's ways
atlas.getFeature(featureId): FeatureInfo | undefined; // once a tile with it has loaded
atlas.getStats(): AtlasStats;                         // fps, frame and cell-pass ms, tiles, decode ms
atlas.setUnderlay(null | { kind: 'imagery' | 'historic-map', id: string });
atlas.on('camerachange' | 'hover' | 'click' | 'flyend' | 'input'
  | 'classeschange' | 'labelschange' | 'contextlost' | 'contextrestored', handler);
atlas.destroy();
```

`classeschange` sends the classes drawn in at least one on-screen cell (for the legend), and `labelschange` the places, landmarks, and monuments whose names are on screen (`{ featureId, name, kind, lngLat }`, for the "Places in view" list); both fire only on change. `contextlost` and `contextrestored` bracket a lost WebGL context (see §3). `input` fires when the visitor moves the camera (drag, wheel, pinch, or keys; not clicks or hover), which also ends any flight; a tour pauses on it. `hover` and `click` carry `{ featureId, feature, point }` (`click` also `lngLat`), where `feature` is the slim `FeatureInfo` the tile worker recorded: class, name, subdivision (and whether it is approximate), landmark id, kind, and height. The package also exports `legendEntries(theme, zoom, present?)` and `CLASS_LABELS` for the legend.

The web app owns app state (Zustand) and pushes it into the renderer. The renderer emits events back. The renderer never reads the URL or the DOM outside its canvas, and it knows nothing about specific cities. Switching cities destroys the atlas and creates a new one with the other city's tiles and meta.

**City meta** (`<city>.meta.json`, generated): `slug`, `name`, `subdivisionLabel`, `languages`, `bounds` (the city boundary bbox), `regionBounds`, `defaultCamera` (centered on the city config's `focus` feature at its zoom, else the boundary centroid), `yearRange` (earliest year with data to the current year), and `attribution` (extra credits the city's layers need).

## 3. Rendering pipeline (per frame)

1. **Camera → visible tiles.**
   - Compute the view frustum in mercator space.
   - Select tiles at `floor(zoom)` for the view, plus a 1-tile margin.
   - Use overzoom for zoom levels above the max tile zoom (z16 recommended).
2. **Tile decode (worker).**
   - Fetch via `pmtiles` range requests, then decode with `@mapbox/vector-tile`.
   - Convert to typed arrays per layer (triangulate polygons with earcut, keep lines as polylines).
   - Runs in a Web Worker; results are cached in an LRU by tile key.
3. **Cell pass (GPU).**
   - Render geometry into an offscreen framebuffer whose resolution equals the cell grid (e.g. 384×108 for a 1920×972 canvas at 5×9).
   - Uses MRT (multiple render targets):
     - `classTex` (RGBA8, red only: feature class id; RGBA so the legend's readback needs no conversion)
     - `attrTex` (RGBA8: height, shade, time-visibility, flags)
     - `idTex` (RGBA8: 32-bit feature id packed)
   - Lines are drawn with width in cell units so roads stay 1 cell wide at every zoom.
4. **Neighborhood pass.**
   - A fragment shader samples each cell's 3×3 neighbors in `classTex` to get road connectivity bits (N/E/S/W and diagonals).
   - The bits index a lookup table of box-drawing glyphs.
5. **Glyph pass.**
   - Full-resolution draw of one instanced quad per cell.
   - Each quad samples the glyph atlas (a canvas-generated monospace font texture, SDF optional) at the chosen glyph and colors it from the theme.
   - Time and animation effects (water shimmer, type-in/dissolve masks, selection glow) are applied here.
6. **Labels.**
   - CPU placement on the cell grid with a greedy, priority-ordered collision grid.
   - Place labels use the glyph overlay. Street labels use a batched glyph-quad pass over it, rotating whole words in screen pixels with the same atlas, theme, halo and deterministic dissolve. Their conservative rotated bounds participate in the same collision grid; short straight runs fall back to beside placement.
7. **Picking.**
   - On hover or click, read back a single texel from `idTex` at the pointer cell, asynchronously (`readback.ts`, see the notes below). A feature that fails the `interactive` option (the web app passes "is a landmark") counts as a miss: it is neither highlighted nor reported.

Rasterization runs only when the camera, year, or tiles change. When idle, only the glyph pass re-runs, for animation.

**Implementation notes (Phase 1).**
- Steps 4 and 5 are split differently: a cell-resolution *select pass* does the neighborhood lookup and all glyph selection, writing one glyph index and class per cell, and the glyph pass is a single full-screen triangle that reads that texture. It gives the same result as instanced quads with less work.
- Class priority is the cell pass's depth value, in tiers; within the building tier, taller features win, so height-less grounds (e.g. a school campus) sit under their buildings.
- The cell grid is anchored to the world, and the glyph pass shifts it by the sub-cell pan offset, so panning scrolls smoothly instead of re-quantizing.
- Zoom follows the 512-px tile convention (`@math.gl/web-mercator`, MapLibre).

**Implementation notes (Place-level detail).**
- **Overlay.** Labels are drawn from an RGBA8 overlay texture on the cell grid (a 16-bit glyph code per cell), over the map in the glyph pass. Map glyphs come first in the glyph atlas so their indices fit the byte-sized glyph table; label characters follow.
- **Top-down only.** The map never mixes in front views: landmark detail comes from plan-view `building_part` footprints (pipeline step 04, from the city pack's `plans/`), which the renderer treats like any building (outlines, priority by height).
- **One matrix path.** The camera is always flat and north-up (the map never tilts or rotates), so the cell pass maps tile units to the world-anchored cell grid with a per-tile affine matrix.

**Life layer (SPEC.md §4).**
- Interaction data travels with `LifeGeometry`: stable, tile-owned site anchors and mode bits, plus building, water, and barrier outlines. `life/navigation.ts` constructs a bounded tile-local walking graph from paths, plaza outlines, and road edges, rejecting blocked connectors. `life/interactions.ts` reserves existing movers for approach, queue, purchase, boarding, shelter, and return states. Searches are staggered across frames; seeds are separate from traffic and bird random streams. Queues and reservations disappear with their owning tile. Scene movement uses the ground collision guard and retraces its approach to resume ordinary movement.
- Cats use a separate seeded stream and at most six slots per tile inside the existing 600-mover cap. Their procedural glyphs reuse the people layer; the map atlas remains below 256 entries. Rain rings and occasional fish are world-anchored effects in the existing glyph shader (`life/water.ts`), adding no render pass. Fish require Life and zoom 18; reduced motion disables both effects.
- The tile worker also emits a tile's `LifeGeometry` (`life/geometry.ts`): road, path, plaza-outline, and river polylines in tile units (roads with their width in meters, so each vehicle keeps to a lane on its half: `life/config.ts` `laneOffset`), plus roost points for birds (park, woods, and water centroids inside the tile) and parking stalls (rows along each parking lot's principal axis, inside the lot and the tile: `raster/geometry.ts` `parkingStalls`). Loaded tiles keep it on the main thread.
- `life/simulate.ts` is pure TS. `LifeWorld` holds a `TileLife` per drawn tile (z13 and deeper), synced when the cell pass runs and seeded from the tile key. Movers walk their polyline in tile units at meters-per-second speeds and pick another usable line meeting at a junction (an endpoint index per tile), else U-turn. Flocks circle a roost. Before moving, each vehicle and boat takes its speed from the nearest one ahead on its line, going its way, whose side-to-side span overlaps its own (`FOLLOW`: gap less a minimum, over a headway, capped at its own speed), so queues form. Parked vehicles are spawned once per tile on lot stalls and along the curbs of some wide roads, from their own random stream; those roads drive on the width left between the parking strips. `step(dt)` clamps `dt` to 100 ms and moves only what could be seen: the kinds that show at the zoom, and, given the view's bounds, the agents within 100 m of them (`STEP_MARGIN_M`). The others wait where they are, except trains, which run on from tile to tile. `visible()` places only those within 30 m of the view, and applies the zoom bands and time-of-day activity (`life/config.ts`), keeps movers inside their own tile (tiles overlap in their buffers), and caps the count.
- **Ground clearance.** Ground clearance uses a shared metric spatial hash over loaded tiles. Parked vehicles and vendor carts reserve oriented footprints; moving ground agents test both destination and swept intermediate bodies, including walkers in a group. Static building and water polygon bins are cached until the tile set changes; road traffic can cross bridges over underlying water. Parking checks actual polygon rings, including holes, rather than only spot centers. Junction envelopes derive from intersecting road segments and their widths. The life packer journals each ground stamp and rolls it back in full if coarse cells would merge it with another ground agent, reserving parked cars first. Connected rail topology is cached by loaded tile set and its per-route seeded arrival clocks are reset after a departing service. Train consists are admitted together under the visible-agent cap.
- Every drawn frame, the **life pass** (`passes.ts`, packing in `life/draw.ts`) projects the agents with the grid placement's `toCell` and writes an RGBA8 `lifeTex` on the cell grid (glyph index, life class id, agent kind bits, and for vehicles and boats their paint in alpha bits 0–3, their part in bits 4–6, and bit 7 for parked, lamps off). A vehicle or boat (`life/vehicles.ts`: kinds, sizes, paints, top-down plans, and the default traffic mix) that is at least `STAMP_MIN_CELLS` long on screen is stamped at its real footprint: the projected 1 m forward and 1 m right vectors give an affine map, each cell center in the footprint's bounding box is mapped back to the vehicle's own coordinates, and the plan gives its part. The glyph pass draws an agent over the map where the map class's `cellBits` allow it, and colors vehicle and boat cells from the theme's `vehiclePaints`, shaded by part. A vehicle's stamp may reach open ground beside the road; a boat's only water. Labels stay on top.
- **Day/night** is a `u_daylight` uniform (0–1). It comes from the solar altitude over the camera, worked out once a second in `life/sun.ts`, or from a fixed value. The glyph pass tints colors with it and lights hash-chosen building cells as windows, by world cell, so they stay put as the map pans.

- **Processions** (`life/procession.ts`): `ProcessionScene` places a procession's boats and crowds along its route (from `<city>.processions.json`) for a progress of 0–1, all in meters along the route and across it. `LifeWorld` plays one on request (`playProcession`, a time-lapse on its own clock) or shows the live one: once a second, with the sun, `liveProgress` checks each schedule in its time zone. Its agents go first in `visible()`, outside the cap, and other river boats are hidden while it runs. The `procession` event tells the web app which one is under way. Crowd people holding candles carry a flag (bit 7) in the life texel's alpha, which the glyph pass lights from dusk (`lamps()`), like vehicles' and boats' lamps. Motion runs on a seeded time warp (`motionProfile`: halts and surges, normalized so a run still ends at the landing), which each boat samples with its own lag behind the lead; boats sway on their own and are placed across the channel between the route's measured `banks`, never within a meter of either. Ropes and poles are line agents (`VisibleAgent.line`): polylines `packLife` rasterizes into line glyphs (`─ │ ╱ ╲`, by their direction on screen) over water only, painted in turn (a pole's stripes), with an optional tip glyph; lines under a cell long aren't drawn.

**Module layout.** `index.ts` holds the public API and wires the frame together; `passes.ts` has the cell, overlay, select, life, and glyph passes; `life/` the life layer's geometry, simulation, tuning, drawing, and sun; `tile-cache.ts` the loaded tiles and which to draw; `gpu-context.ts` the programs, theme resources, and render targets; `flight.ts` fly-to; `picking.ts` the pointer picker; `readback.ts` asynchronous GPU reads.

**Implementation notes (Phase 2).**
- **Crossfades.** Each frame the cell pass gets every class's visibility (`bandVisibility` of its `CLASS_ZOOM` band, 0–1). A partly visible class keeps only the cells whose per-world-cell hash falls under its visibility and discards the rest, so it dissolves into the layer beneath and the dither stays put while panning.
- **Region layers.** The sea, coastline, terrain, and admin boundaries are ordinary classes: terrain bands nest, and the band number in the height byte makes the higher band win (the `ramp` glyph kind picks `. : - = + * # %` from it). Admin lines are see-through for outlines and curbs.
- **Picking.** The pointer maps to a cell by inverting the glyph pass (`picking.ts`). After a frame is drawn, one texel of `idTex` is read, at most once per frame, without blocking: `readback.ts` issues `readPixels` into a pixel-pack buffer with a fence, and copies the data out a frame or two later, once the fence has signaled. A read from render targets that were recreated in between (a resize) is dropped. The tile worker sends a `FeatureInfo` for each feature it registers, so an index resolves to a feature without keeping tiles on the main thread.
- **Selection.** The select pass compares each cell's feature index with the hovered, selected, and highlighted indices and writes a state into the glyph texture's spare channel; the glyph pass brightens hover and draws the accent color (with a shimmer for the selection, unless reduced motion is on).
- **Fly-to.** Flights follow van Wijk and Nuij's zoom-and-pan path (as MapLibre's `flyTo`), eased, 0.8–3 s (≤0.3 s with reduced motion). Any input cancels one.
- **Zoom-out limit.** On every resize, the minimum zoom becomes the zoom that fits `regionBounds` in the view, and the view keeps the whole screen over the region.

**Implementation notes (post–Phase 2 hardening).**
- **Legend of what is on screen.** After a cell pass (at most every 250 ms, and always after the last one), the on-screen part of `classTex` is read back the same asynchronous way, and the set of class ids present is sent as `classeschange`. `legendEntries` drops a zoom-visible class that the cell pass draws but that isn't present.
- **Labels fade.** Labels use the classes' fade (`bandVisibility`, half a level at each band edge). A partly visible label keeps its whole box for collision, but only the share of its cells (text and halo) whose hash of (label, cell) falls under its visibility, so it dissolves like a class and the pattern holds while panning.
- **Lines claim their vertices' cells.** GL_LINES skips a segment that never leaves one cell's center diamond, so a river of many short segments broke into dashes at the City level. The tile worker also emits a point at every line vertex, which always covers its cell.
- **Lost context.** On `webglcontextlost` the renderer calls `preventDefault()`, stops its loop, and forgets every GPU handle without deleting it (the tile cache drops its meshes, and tiles that arrive meanwhile). On `webglcontextrestored` it recompiles the programs, rebuilds the glyph atlas and render targets, and asks for the view's tiles again; feature indices survive, since the worker keeps its id registry.

**Implementation notes (legibility: two colors per cell, sub-cell edges).**
- **Fill.** The select pass writes a fourth byte, the class whose fill is the cell's background (`fillClass`: the cell's own class, except carriageways drawn as 1-cell lines). The glyph pass mixes the background toward that class's color by its `fill` strength (`GlyphTables.fills`), then draws the glyph over it. Agents are drawn over the same fill.
- **Sub-cell targets.** The cell pass runs its ground draw a second time into class, attribute, and id targets at `SUB` (2 × 3) samples per cell (`CellTargets.sub`). The crossfade hash divides the fragment position by the sample count, so both resolutions keep the same cells.
- **Edges.** For an empty cell or an area cell (`subcellClasses`) that isn't walled, the select pass picks the foreground feature (the cell's own area, or a building among the samples), builds a 6-bit mask of the samples whose id matches it, and on a partial mask emits that sextant (two glyph-table rows, `SEXTANT_ROW`) with `EDGE_STATE` set in the state byte and the first other sample's class as the fill. The glyph pass draws an edge's ink between the feature's fill and its color (`EDGE_INK`).

**Implementation notes (cell size by zoom).**
- **Steps.** `density.ts` holds the schedule (`DEFAULT_CELLS`), `cellStep` (with `STEP_HYSTERESIS`), and `detailZoom`. Each frame, `index.ts` checks the camera zoom's step; a new step marks the size dirty, and `resize` switches to that step's map glyphs (atlas and glyph table, built the first time and kept per step until the theme or pixel ratio changes, or the context is lost) and recreates the targets at the new grid size. The grid re-quantizes at a step change; the step edges fall mid-zoom, while every cell is already re-rasterized.
- **Two grids.** Labels have their own grid and atlas (`LabelGlyphs`, `labelCharacters` at `labelCell`), so they stay 10×18 while the map shrinks. `placeGrid` places either grid from its cell size (world-anchored); the overlay texture has the label grid's size, and the glyph pass finds a pixel's label cell from `u_labelCell` and `u_labelShift`. Map glyphs (`mapGlyphs`: styles, walls, sextants, vehicles, and people) have the map atlas to themselves, which keeps their indices within the byte-sized glyph table. Picking, the life layer, and the legend readback use the map grid.
- **Detail zoom.** `View.detailZoom` goes to the cell and select shaders as `u_zoom`, so `OUTLINE_ZOOM`, `ROAD_AREA_ZOOM`, and `ROOF_ZOOM` are reached sooner with smaller cells; class visibility, labels, and life bands use the camera zoom. Below 8 device px, shade blocks lose their one-pixel gap (`SHADE_GAP_MIN_WIDTH`), which would otherwise draw a mesh over buildings.

## 4. Glyph selection rules

The rules live in `glyphs/select.ts` and mirror the shader logic, so they can be unit-tested on the CPU.

- **Water:** alternates `~`/`≈` using `hash(cell) + time`, unless reduced-motion is on. Rivers and streams (styles with the six stroke glyphs) draw a 1-cell-wide run that isn't horizontal as a stroke instead: `(` and `)` alternating down a vertical run, `╱` / `╲` for a diagonal one, judged from which neighbors are any water class.
- **Buildings:** luminance from shade × height factor maps onto the `░▒▓█` ramp.
- **Roads:** connectivity bitmask → box-drawing LUT. Road hierarchy picks a single-line or double-line set.
- **Area fills** (farmland, parking, pitches): patterned by `(x + y) mod n` so fields form rows.
- **Grass and parks (`grass` kind):** tufts at rest, grown from a soft value noise (`GRASS.lushScale`) plus a hash per cell (`grassCell`: dense, medium, thin, or sparse), whose same noise tints the cell: deep green above `shadeAbove`, straw below `dryBelow`, and a few straw specks in the margin. `windFront` sweeps fronts downwind (`WIND`: from the northeast, a front every 56 cells at 7 cells/s), bent by value noise and gated by slowly drifting noise patches, and returns the `gust` and the `wake` just behind its crest; above `GUST_STEPS` a blade leans downwind (`/`, `\`, or upright `|` when the wind runs along the columns), then lies flat. Most cells are in neither the front nor its wake, so `windFront` returns before the patch noise (two thirds of its hashing). The select pass gets `u_wind` = 0 with reduced motion and then skips the wind math altogether. The noise stays in integers until its last step, so world coordinates at z21 stay exact in the shader (`shaders/vegetation.ts`).
- **Woods (`canopy` kind):** a jittered crown center per 4 × 2 block of cells; the cell holding a center draws a crown glyph (by the wood's kind in the variant byte), cells around it foliage, and cells far from every center are clearings half the time (the gap dots are picked by the fixed world cell, so a moving clearing reveals them one by one). Foliage more than `CANOPY.lit` cells from its center toward the sun is lit, and away from it shaded.
- **Trees:** the worker draws a `natural=tree` point's crown (`tree_crown`, a render-only class that follows `tree`'s zoom band) as a lumpy 24-gon (`crownRing`: two sine lobes, a little jitter, and an oval stretch, scaled so its mean radius is half the `crown` diameter), seeded by a hash of the tree's id so the same tree has the same shape in every tile, and triangulated with earcut, since the lobes aren't convex; a crown every crown's width along a tree row, each seeded by its index too.
- **Trees in the wind:** trees read the grass's wind field `TREE_WIND.lag` (0.35 s) late (`treeFront`, `treeGust`). Crowns are kept out of the cell pass, in their own buffers (`TileGeometry.crowns`, each vertex's `ridge` its reach from the trunk). The cell pass draws everything else into base targets (`CellTargets.base` / `subBase`); the crown pass (`passes.ts crownPass`) blits the base into the live targets and draws the crowns over it. It runs after every cell pass and on every animated frame while crowns are on screen and the wind is on, so the per-frame cost is the base copy (`copyRaster`: up to four `blitFramebuffer` calls per grid, twice: the cell grid and the sub-cell grid) and the crowns' triangles, with each tile's matrix worked out once for both grids. In the cell vertex shader, each crown vertex swings downwind by the gust at its own cell times `SWAY.bend` × its reach in cells (at most `SWAY.max`), and springs back upwind of rest in the wake behind the gust (`SWAY.recoil`, rocking at `SWAY.bounce`), plus a flutter across the wind at its own phase (`gl_VertexID`). Where a crown swings away, the base shows the ground under it. Leaves flutter between `%` and `&` from `TREE_WIND.step` (`FLUTTER`); woods, which have no per-tree geometry, read their canopy pattern from up to `CANOPY.sway` cells upwind in a gust (a fractional offset: a whole shift plus a fraction, so the arithmetic stays exact in float32 and the clumps creep a cell at a time), so the clumps lean downwind and back. A flat crown draws a rim of `%` around an inside of `&` (with a dense `@` here and there), read from its neighbors in the class texture; its sunny side (toward `u_sun`, or the northwest at night) is lit and the far side shaded, and one crown in `CROWN.dryEvery` (by feature id) yellows. The wind level (`windLevel`, 0–3) and a tone (`Tone`: shade, light, dry) ride in the state byte, and the glyph pass lightens by `WIND_LIGHT[level]` and tints by `TONE`, relative to the class color so both themes work. `u_wind` = 0 (reduced motion) stills all of it, and the crown pass then runs only after cell passes.
- **The wind is live state** (`life/wind.ts`): `prevailingWind` picks the season's wind from the city pack's `climate` for the month (or the HUD's chosen strength, from the season's direction), and `windAt` veers it up to `WIND_VARIATION.veer` degrees and breathes its strength on slow noise. Each frame `index.ts` passes `{ dir, strength }` to the crown and select passes as `u_windDir` (a unit vector) and `u_wind` (0 with reduced motion). Fronts are laid out on world cells taken modulo `WIND.wrap` (4096), so float32 stays exact at z21. Fields (`crop` kind) and water gust bands read the same field.
- **Rain** (`RAIN`, `rainDrop`): with a storm, the glyph pass draws sparse streak cells falling `RAIN.speed` cells a second and drifting with the wind's x, in a glyph slanted by it (`theme.ts rainGlyphs`), over a slightly dimmed map. Rows are taken modulo `RAIN.wrap` first.
- **Shadows** (`SHADOW`, `inShadow`): the select pass looks up to `SHADOW.steps` cell widths toward the sun (`u_sun`: its direction and the tangent of its altitude, from `life/sun.ts solarPosition`, or `fixedSun` for the fixed day and dusk) for a building, tree, or crown standing taller than the sun rises over that distance, and sets `SHADOW_STATE` (8); the glyph pass darkens the cell by `SHADOW.dark`. The state byte: bits 0–1 hover/highlight/selected, 2 sub-cell edge, 3 shadow, 4–5 wind level (`WIND_SHIFT`), 6–7 tone (`TONE_SHIFT`).
- **Birds in trees:** the worker emits each tree point in a tile as a perch (`LifeGeometry.perches`, at most `MAX_TILE_PERCHES`). A flock picking where to go next flies to a tree with chance `PERCH.chance` and sits in it, still; `LifeWorld.step` takes a `gustAt(lng, lat)` (strength × `treeGust` on the grid's cells), and a gust over `PERCH.flush` flushes the flock, which scatters for `PERCH.scatter` seconds.
- **Labels** draw `labelText(name)`: NFKC (`Ⅱ` → `II`) and ASCII punctuation, so names fit the label atlas; search folds with NFKD for the same reason.
- **Terrain:** DEM luminance → `. : - = + * # %` ramp (Region level only).
- **Priority:** when several classes fall in one cell, a fixed priority order decides (label > landmark > road > building > water > tree crown > area > grass > terrain).
- **Road strips (Place level):** from `ROAD_AREA_ZOOM`, carriageways are drawn as strips of their real width (built in the worker) instead of lines; road cells next to a non-road cell become curbs via the same wall mask, with "outside" meaning any class that is neither road nor see-through.
- **Roof ridges:** the tile worker gives each pitched-roof polygon a ridge along its principal axis, and each vertex its signed distance to it (positive on the lit slope). The cell pass marks a cell as ridge when `|d| ≤ fwidth(d) / 2` (the ridge line crosses it), else lit or shaded slope. From `ROOF_ZOOM`, interior cells draw `▓` / `▒` and the ridge as `─ ╲ │ ╱`, chosen from its angle in cell units (cells are 1.8× taller than wide). Flat roofs and landmark parts keep the height ramp.
- **Outlines (Place level):** from `OUTLINE_ZOOM`, a cell of an outlined feature is a wall if any of its 8 neighbors belongs to another feature (per `idTex`; paths, statues, and markers are looked through). A wall joins its neighbor in a direction when that neighbor is in the same feature and a cell touching both is outside, which draws corners and concave corners correctly without false junctions in thin buildings. The join mask indexes the single- or double-line wall set. Grounds (no height) are never outlined.
- **Sub-cell edges:** `subcellEdge` mirrors the select shader: only empty cells and areas take part (lines and markers win their cells whole); a building among the samples wins over the grounds, park, or water it stands in; walled features are left to their walls; a full or empty mask keeps the class glyph. The mask's bit `row × 2 + col` is the sample's sixth, from the top left, and indexes `sextantGlyphs`.
- **Classes by zoom:** each class has a zoom band in the shared `CLASS_ZOOM` table (e.g. `monument` from z17, terrain until 9.5); the cell pass crossfades it at the band's edges (see the Phase 2 notes above).
- **Labels:** place names (provinces, cities, subdivisions, smaller places, each with the band `featureZoomBand` gives it), curated landmarks (from z16), street names (tiered by road class and OSM `highway` kind in `streetLabel`: major roads from z14, secondary from z15.5, tertiary from z17.5, other streets from z18, paths from z18.5), and monuments (from z18) are placed greedily by rank, then feature id, inside the on-screen cells, never overlapping, with a one-cell halo. Names beside an anchor go below, above, right, or left of it, wrapped at 18 characters. A street's name sits at the middle of its longest straight run, with glyphs rotated to that direction and normalized to an upright reading angle. Run endpoints determine whether the whole word fits; short runs, edge clipping and collisions fall back to horizontal beside placement. Rotated halo bounds reserve the collision grid and a dynamic vertex buffer batches the accepted glyph quads. The same name within 30 cells is placed once.

## 5. Time model

- Every feature can carry:
  - `start_year?`, `end_year?`
  - `certainty?: 'exact' | 'circa'`
  - `name_history?: { name, from?, to? }[]`
- The pipeline writes these into tile feature properties.
- **Visibility.** In the cell pass, a uniform `u_year` is compared per feature, and invisible features are discarded. Visibility per feature is `start_year <= year && (end_year == null || year < end_year)`.
- **Transitions.** When the year changes, the previous and next visibility are both rendered. A per-cell mask (`scanOrder(x, y) < t`) decides which one shows, which produces the type-in and dissolve effects.
- **Names.** `name_history` is resolved on the CPU during label placement.
- **Underlays.** Imagery snapshots are pre-baked by the pipeline into grayscale raster tiles per year. The glyph pass samples the underlay luminance for cells with no feature class.

## 6. App state (Zustand)

```ts
type AtlasState = {
  city: string;                 // slug, from the route
  camera: CameraState;          // lat, lng, zoom (always flat and north-up)
  year: number;
  timelineOpen: boolean;
  playing: boolean;
  selectedId: string | null;
  hoverId: string | null;
  tour: { id: string; step: number; paused: boolean } | null;
  underlay: { kind: 'imagery' | 'historic-map'; id: string } | null;
  theme: 'dark' | 'light';
  cellSize: number;
};
```

**URL sync.**
- The city is the path (`/<city>`), and everything else is in the query string.
- Debounced (250 ms) `history.replaceState` for camera changes.
- `pushState` for selections and tour starts, so the back button works.
- Parameters: `lat, lng, z, year, sel, tour, step`. Links from before the map went flat may carry `pitch`, `bearing`, or `mode`; they are ignored.

## 7. Search

- The pipeline emits `<city>.search-index.json` for each city:
  - one entry per searchable feature: `id, name, altNames, type, subdivision, lat, lng, zoomHint`
  - plus a serialized MiniSearch index
- The web app lazy-loads the current city's index on the first `/` press. Search is scoped to the current city.
- Fuzzy matching with prefix search. Diacritics are folded, so "Penafrancia" matches "Peñafrancia".

## 8. Performance budgets

| Metric | Target |
|---|---|
| Frame rate | 60 fps desktop, ≥30 fps mid-range Android |
| Initial JS (web app, gzipped) | < 250 KB; the map renderer loads as a separate chunk |
| Map renderer chunk (gzipped) | < 120 KB |
| First meaningful render | < 2.5 s on 4G |
| `<city>.pmtiles` size | < 40 MB per city (the city plus its region at low zoom) |
| Tile decode | off main thread; < 16 ms per tile on desktop |

Zod stays out of the browser bundle: the pipeline validates each generated file with its schema when it writes it, the web app checks only their shape (`apps/web/lib/guards.ts`), and `packages/shared` keeps the plain values the browser needs (class list, camera ranges, search options) in zod-free modules and is marked side-effect free. CI checks the size budgets after the static build (`pnpm check:budgets`: the gzipped scripts each city page loads, the separate renderer chunk, and each `<city>.pmtiles`). The tile worker and legacy `nomodule` polyfills are excluded from initial JS. Frame rate and decode time are checked by hand on real devices with the `?debug=1` overlay, which shows the renderer's `getStats()` (headless CI runs WebGL in software, so its timings mean little).

### Frame preparation and diagnostics

Adaptive quality changes drawing only: Auto first thins drawn agents (1,200 → 700 → 500), then disables crown sway, ground wind, shadows, water detail, fish and beams, then caps DPR at 1.25. High pins the original drawing settings; Low pins the last tier. CSS-scheduled simulation clearance and gust coordinates remain independent of drawing DPR. Auto samples the next rAF callback after each draw, including callbacks that skip drawing; idle 30 fps pacing is not an overload signal. A bounded ten-second window requires 45 samples. Sustained p75 intervals above 25 ms for three seconds, or 40 ms for 1.5 seconds, lower quality after input has been quiet for one second. An eight-second cooldown and delayed, backed-off recovery trials prevent oscillation. Recovery requires healthy interval and CPU samples, changes no draw cadence, and does not require diagnostic profiling.

- Empty tile meshes have `count: 0`, a null VAO, and no buffers. Drawing and disposal skip them.
- Theme palettes are converted to RGB once per theme change. Vehicle part glyph indices belong to each map glyph atlas, rebuilt for theme, density, DPR, or context changes.
- Crown filtering and matrices are reused while tiles, meshes, zoom, DPR, cell dimensions, grid origin, and target dimensions stay the same. A shift inside a cell does not change a matrix.
- Label grids, collision storage, and packed upload buffers are reused per render target and fully reset before placing labels again. Maps do not share mutable buffers.
- `Atlas.setReducedMotion(enabled)` applies a system preference change immediately while preserving saved Life settings. It clears agents and moving lights, stills animated effects, finishes an active flight once at its destination, and resets the simulation step clock before resuming. The web app and HUD subscribe to the same media query.
- Back/Forward cancels pending URL writes and restores camera, selection, year (including the default when absent), and the requested tour step paused. Even a step of the currently open tour is restored. History restoration stops old flights and tour holds and does not enqueue a new history write.

`getStats().frameMs` measures CPU submission time. `gpuFrameMs` is a separate, smoothed GPU elapsed measurement in milliseconds, or `null` when disabled, unsupported, awaiting results, or invalidated by a disjoint event. `AtlasOptions.gpuTiming` defaults to false; the web app enables it only when the initial URL requests `debug=1`. Timing uses asynchronous `EXT_disjoint_timer_query_webgl2` queries around rendering commands, sampled at most once per 250 ms with at most four outstanding queries. It waits for availability, discards disjoint results, resets on context loss, and never requests a redraw to collect a sample. The debug overlay labels these counters `cpu` and `gpu`; unavailable GPU timing reads `n/a`.

### Simulation experiments

#### Complete workload and browser captures

`pnpm perf:world` compares complete seeded worlds against `00f1f6f` by default; `--baseline=<revision>` selects another revision. Renderer and shared runtime sources are frozen together, including collision helpers and workspace imports. Third-party dependencies must use the same lockfile. Each variant starts fresh with the same seed and scripted inputs for each of five alternating runs, warms up for 90 steps, and records 160 individual frames. `--case=<prefix>`, `--samples=<count>`, `--runs=<count>`, and `--output=<path>` narrow or configure a run.

The matrix covers sparse traffic, crowded intersections, transit/vendor scenes, and alternating rain/shelter activity, with 1/4/16 loaded tiles and desktop/phone viewport bounds at z18. Transit and rain fixtures use a jeepney fleet so eligible stop service is exercised. Timed synthetic fixtures explicitly use a 0.9 m minimum ground footprint and 10×18 pixel packing cells; these are declared test inputs. The browser capture uses the real viewport, density and DPR. Full `LifeWorld.step`, visibility, packing, and combined CPU costs have individual-run and aggregate median/p95 results. Exact visible outputs are compared for 300 frames with 0/0.9/3 m footprint changes, with mover/scene state and packed texels compared every 30 frames. Actual populations, scene activity, source graph hashes, dependency hash, runtime, CPU, and heap deltas accompany the timings. Heap deltas are diagnostics; structural tests check retained ownership. Source changes during a run invalidate its comparison.

`--overhead` adds five alternating pairs of plain and instrumented runs, including profiling setup/sample storage in instrumented combined CPU time. Instrumented reports also contain raw samples and clearance stage summaries. Normal timing runs disable the profiler. The gate requires at least 10% median step improvement in every dense target and at most 5% p95 regression in step or combined cost elsewhere; repeat any apparent regression before accepting or rejecting the change. Reports remain in ignored `test-results/`.

`AtlasOptions.profiling` defaults to false. When enabled, `getProfile()` returns a detached snapshot of at most 4,096 callback samples, the retained window's `spanMs`, overwritten sample count `dropped`, available `gpuRenderer` (otherwise null), and stage median/p95 values; `resetProfile()` releases samples and clears the dropped count, and context loss also resets them. GPU identity is read from the renderer's own context at creation and after restoration, only with profiling enabled. The stage counters cover callback CPU time, drawing, simulation, clearance preparation/checks, visibility, packing and upload. Clearance is included in simulation time, and simulation/packing/upload are included in drawing and callback time. Missing stages have zero samples and null quantiles. GPU time retains its separate asynchronous counter. Quantiles are calculated on request, outside the frame path.

The `?debug=1` panel enables profiling and offers Reset, Capture 30 seconds, and Download. Its UI is loaded only on request. Tests can shorten captures with the debug-only `captureMs` parameter, cached before URL mirroring removes it; share URLs omit it. Captures include raw bounded samples, settings and camera at both ends, viewport/DPR, browser and available GPU backend information. Backend classification distinguishes hardware-reported, software and unidentified renderers. If samples were overwritten, the panel reports the retained window and dropped count. Panel text lets map dragging pass through; its controls receive clicks.

`pnpm perf:browser` prepares the current static export, serves it locally on port 3198 (`E2E_PORT` overrides it), and captures a visible desktop Chromium with calm and storm wind at noon. It warms up for five seconds after tiles finish loading, then alternates opposite arrow inputs every 250 ms for a 30-second active-camera capture. Reports are `test-results/browser-calm.json` and `browser-storm.json`; software backends establish functional behavior only. For a physical phone later, open the same static site with `?debug=1`, allow the initial tiles to load, and use the same capture/download controls. Phone viewport CPU fixtures and software browser timings do not establish physical-phone performance.

Combined unit scenarios run 180 simulated seconds with one fixed seed using bounded test populations; benchmark fixtures retain full populations. Controlled scene fixtures retain two seeds and ensure purchasing, boarding, hidden passengers and returning complete through the world's collision guard. Lifecycle checks also retain two seeds and repeat 100 pan-away/return and tile eviction/reload cycles, verify seeded respawn and frozen out-of-view poses, and check unique ownership, queue capacities, seats, service limits, finite coordinates and bounded cooldown storage. Focused replays cover 30/60/120 Hz and oversized-step clamping. Collision scratch buffers are per index/world, clear owner references after queries, and stored bodies use per-owner double buffers so rejected trials cannot overwrite accepted reservations. Transform caches release evicted tiles immediately.

The September 30, 2026 comparison against `00f1f6f` retained these allocation changes. Both complete 24-case matrices passed the 10% dense-step / 5% p95 gate; the repeat used the refined transit fleet and changing-footprint correctness checks. On the Ryzen 5 2600X, Windows 10, Node 24.12.0, the repeat reduced dense median step time by 16.3–40.5% and combined step/visibility/packing time by 7.1–36.0%. Every exact state/output/packed-texture comparison passed. No measured step or combined p95 regressed; the smallest combined p95 improvement was 0.2%, within timing noise. Runtime source SHA-256: `956705c0ee6df956321131a56d6d66f1303e29a67109d6b26bec22fb34684a4d`.

| Desktop fixture, 16 loaded tiles | Baseline step median, ms | Current step median, ms | Median reduction | Step p95 change |
| --- | ---: | ---: | ---: | ---: |
| Crowded intersection | 6.837 | 5.314 | 22.3% | −29.5% |
| Transit/vendor scenes | 7.581 | 5.628 | 25.8% | −21.0% |
| Rain/shelter activity | 7.016 | 5.169 | 26.3% | −16.8% |

Five alternating plain/profiled pairs for `transit/1/desktop` measured 4.816/4.975 ms median combined CPU time, a 3.3% instrumentation overhead. This is a representative synthetic workload, not an overhead bound for every browser or density. The profiler remains off by default.

The visible-browser captures used Chromium 153, a GTX 1650 SUPER reported through ANGLE Direct3D11, 1920×1080 at DPR 1, Naga at z18/noon, 17 loaded tiles, and alternating camera inputs. Both ends were focused and visible. The 30-second calm/storm captures averaged 59.5/59.6 drawn frames per second; callback CPU median/p95 was 13.4/17.6 ms calm and 12.7/17.1 ms storm. Median per-frame clearance share of simulation time was 71.6/72.8%. These captures validate the current desktop workload, with occasional callbacks above the 16.7 ms frame budget. They establish no physical-phone result or before/after browser FPS gain.

The WebGL canvas loads as a separate client chunk, and its download starts when the city module evaluates in the browser, overlapping hydration while the HUD and page content initialize. Initial gzipped JavaScript has a 250 KB budget; the renderer chunk has a separate 120 KB budget. The budget check requires one identifiable asynchronous renderer chunk and fails if it is missing or ambiguous.

#### Earlier isolated prototypes

`pnpm perf:life` compares seeded simulation fixtures against a Git revision (`--baseline=<revision>`) or a source snapshot (`--baseline-file=<path>`). Dependencies come from the current checkout, so use a fresh snapshot to isolate an optimization when other simulation features have changed. The harness checks exact visible outputs and mover states before timing, alternates five runs of each variant, and reports median and p95 CPU durations, source hashes, runtime, and the actual warmup and batch sizes.

For an isolated prototype comparison in PowerShell:

```powershell
New-Item -ItemType Directory -Force test-results | Out-Null
Copy-Item -LiteralPath packages/renderer/src/life/simulate.ts -Destination test-results/life-before.ts
pnpm perf:life --baseline-file=test-results/life-before.ts --candidates --case=visible --output=test-results/candidates.json
pnpm perf:life --baseline-file=test-results/life-before.ts --following --case=traffic --output=test-results/following.json
```

The candidate prototype pools metadata, delays headings and appearances until selection, and uses a stable bounded heap above the 1,200 ordinary-agent cap; procession agents are separate. The following prototype reuses line/direction groups and scans lateral/width buckets in reverse progress order, retaining the exact strict overlap check and progress/index tie order. Both live under `packages/renderer/scripts/prototypes`; production simulation does not import them.

Fixtures cover 1/4/16/64 tiles with desktop and phone viewport bounds, an artificial repeated-coordinate crowd, and 16/120/600 mixed vehicles. The artificial crowd uses tile simulations directly so collision settling does not remove repeated-coordinate agents; its stepping deliberately excludes cross-tile collision handling. These measurements isolate placement and following costs. They do not establish browser FPS, GPU cost, or performance on a physical phone.

Retain a complex simulation optimization only when its dense target cases improve median CPU time by at least 10% and repeated runs show no p95 regression greater than 5% in other cases. Preserve agent density, visual output, activity rules, traversal/tie order, and seeded random streams. Otherwise retain the existing production algorithm.

The September 30, 2026 run (Node 24.12.0, Windows x64, snapshot SHA-256 `99e0309dff1e577d96ee0fc245194ab4d0a7192ade5a6a2da738f8146b266f5d`) rejected both prototypes for production:

| Prototype / fixture | Baseline median, ms | Prototype median, ms | p95 change |
| --- | ---: | ---: | ---: |
| Candidates, desktop / 1 tile | 0.266 | 0.731 | +174.5% |
| Candidates, phone bounds / 1 tile | 0.122 | 0.263 | +203.8% |
| Candidates, artificial crowd / 16 tiles | 13.080 | 9.650 | −36.2% |
| Candidates, artificial crowd / 64 tiles | 28.151 | 13.049 | −59.2% |
| Following buckets, 600 vehicles | 0.265 | 0.463 | +60.5% |

Candidate pooling improved the large artificial crowd but regressed small views. Following buckets regressed all three traffic sizes; a second complete traffic run confirmed the direction (600 vehicles: median 78.5% slower, p95 52.7% slower). Exact output and mover-state comparisons passed. The JSON reports are written to ignored `test-results/` files. These are local experimental results, not a claim that the frame-rate budgets have been reached.

## 9. Testing

- **Unit (Vitest):**
  - glyph selection LUTs
  - time visibility
  - label collision
  - URL (de)serialization
  - zod schemas
  - camera math (fly-to arcs, bounds clamping)
- **Pipeline:**
  - snapshot test on a small fixture OSM extract with a fixture city config (not tied to any real city)
  - asserts expected layers and properties
- **E2E (Playwright):** a small smoke suite (`apps/web/e2e/smoke.spec.ts`) for what unit tests can't see, run against the static export on desktop Chromium; tests tagged `@mobile` also run on a Pixel 7 (touch and the bottom sheet). Logic (tour player, URL state, life preferences) is unit-tested instead. For each registered city:
  - `/` reaches a city, and the canvas draws with attribution
  - search flies to the smoke landmark from its `city.json` (Naga: "Naga Metropolitan Cathedral"), and a click on a place opens the panel
  - share URL round-trips
  - the map redraws after a lost WebGL context is restored
  - the city's first tour plays end to end
  - timeline scrub changes the rendered cell hash (Phase 4)
- **Visual regression:** screenshot a few fixed camera states per theme, with a tolerance threshold.

## 10. Deployment

- `next build` with `output: 'export'` produces a static site on Vercel. The web app's `build` script reuses an unchanged, complete export; when rebuilding, it fetches each city's published tiles first (the GitHub release its `tiles.lock.json` names, DATA.md §9) into `public/tiles/`. Its fingerprint in `.next/cache/atlas-export.json` covers build inputs and export file hashes and is saved only after a successful build with stable inputs. E2E prepares the export before Playwright can reuse a running static server. `pnpm build:force` bypasses export reuse. The repository is private, so the Vercel project needs a `GITHUB_TOKEN` environment variable with read access to its contents; CI uses the workflow's token.
- PMTiles and imagery are static files. If they exceed Vercel limits, host them on Cloudflare R2 or similar with CORS and range requests enabled.
- Set long cache headers on tiles, and add a content hash in the filename (e.g. `<city>.<hash>.pmtiles`) for cache busting.

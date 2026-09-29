# Architecture — ASCII Atlas

The engine is city-agnostic. Everything specific to a city lives in its city pack (`packages/content/cities/<slug>/`) or is derived from OSM by the pipeline. Examples below use Naga, the first city.

## 1. Repository layout

```
ascii-atlas/
├─ CLAUDE.md
├─ docs/                      SPEC, ARCHITECTURE, DATA, ROADMAP
│  └─ cities/                 one brief per city (naga.md, …)
├─ package.json               root scripts (dev, data:build, test, lint, typecheck)
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ apps/
│  └─ web/                    Next.js App Router, static export
│     ├─ app/                 layout, global styles, `/` landing (redirect or city picker)
│     │  └─ [city]/           per-city page, static params from the city registry
│     ├─ components/          AtlasCanvas, SearchBox, InfoPanel, Timeline, TourPlayer, Hud
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
│  │     ├─ picking.ts        id buffer readback → feature id
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
  cell: { width: 10, height: 18 },
  bounds: meta.regionBounds,
  initialCamera: urlCamera ?? meta.defaultCamera,
  year: 2026,
});

atlas.setCamera(partial, { animate?: boolean });
atlas.flyTo(target: CameraState, opts?);
atlas.setYear(year: number, { animate?: boolean });
atlas.setTheme('dark' | 'light');
atlas.setSelected(featureId | null);
atlas.setHighlighted(featureIds: string[]);
atlas.setUnderlay(null | { kind: 'imagery' | 'historic-map', id: string });
atlas.on('camerachange' | 'hover' | 'click' | 'flyend', handler);
atlas.destroy();
```

The web app owns app state (Zustand) and pushes it into the renderer. The renderer emits events back. The renderer never reads the URL or the DOM outside its canvas, and it knows nothing about specific cities. Switching cities destroys the atlas and creates a new one with the other city's tiles and meta.

**City meta** (`<city>.meta.json`, generated): `slug`, `name`, `subdivisionLabel`, `languages`, `bounds` (the city boundary bbox), `regionBounds`, `defaultCamera` (the boundary centroid unless the city config overrides it), `yearRange` (earliest year with data to the current year), and `attribution` (extra credits the city's layers need).

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
   - Render geometry into an offscreen framebuffer whose resolution equals the cell grid (e.g. 192×54 for a 1920×972 canvas at 10×18).
   - Uses MRT (multiple render targets):
     - `classTex` (R8: feature class id)
     - `attrTex` (RGBA8: height, shade, time-visibility, flags)
     - `idTex` (RGBA8: 32-bit feature id packed)
   - Lines are drawn with width in cell units so roads stay 1 cell wide at every zoom.
   - Orbit mode draws extruded building meshes with depth testing; face normals feed shade.
4. **Neighborhood pass.**
   - A fragment shader samples each cell's 3×3 neighbors in `classTex` to get road connectivity bits (N/E/S/W and diagonals).
   - The bits index a lookup table of box-drawing glyphs.
5. **Glyph pass.**
   - Full-resolution draw of one instanced quad per cell.
   - Each quad samples the glyph atlas (a canvas-generated monospace font texture, SDF optional) at the chosen glyph and colors it from the theme.
   - Time and animation effects (water shimmer, type-in/dissolve masks, selection glow) are applied here.
6. **Labels.**
   - CPU placement on the cell grid with a greedy, priority-ordered collision grid.
   - Drawn as glyphs in the same pass, so they look native.
7. **Picking.**
   - On hover or click, read back a single texel from `idTex` at the pointer cell (`readPixels`, throttled).

Rasterization runs only when the camera, year, or tiles change. When idle, only the glyph pass re-runs, for animation.

## 4. Glyph selection rules

The rules live in `glyphs/select.ts` and mirror the shader logic, so they can be unit-tested on the CPU.

- **Water:** alternates `~`/`≈` using `hash(cell) + time`, unless reduced-motion is on.
- **Buildings:** luminance from shade × height factor maps onto the `░▒▓█` ramp.
- **Roads:** connectivity bitmask → box-drawing LUT. Road hierarchy picks a single-line or double-line set.
- **Area fills** (parks, farmland): patterned by `(x + y) mod n` so fields form rows.
- **Terrain:** DEM luminance → `. : - = + * # %` ramp (Region level only).
- **Priority:** when several classes fall in one cell, a fixed priority order decides (label > landmark > road > building > water > area > terrain).

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
  camera: CameraState;          // lat, lng, zoom, pitch, bearing
  mode: 'map' | 'orbit' | 'walk';
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
- Parameters: `lat, lng, z, pitch, bearing, year, sel, tour, step, mode`.

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
| Initial JS (web app, gzipped) | < 250 KB excluding the renderer worker |
| First meaningful render | < 2.5 s on 4G |
| `<city>.pmtiles` size | < 40 MB per city (the city plus its region at low zoom) |
| Tile decode | off main thread; < 16 ms per tile on desktop |

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
- **E2E (Playwright):**
  - `/` reaches a city, and the canvas is non-blank
  - for each registered city, search flies to the smoke landmark from its `city.json` (Naga: "Naga Metropolitan Cathedral")
  - timeline scrub changes the rendered cell hash
  - share URL round-trips
- **Visual regression:** screenshot a few fixed camera states per theme, with a tolerance threshold.

## 10. Deployment

- `next build` with `output: 'export'` produces a static site on Vercel.
- PMTiles and imagery are static files. If they exceed Vercel limits, host them on Cloudflare R2 or similar with CORS and range requests enabled.
- Set long cache headers on tiles, and add a content hash in the filename (e.g. `<city>.<hash>.pmtiles`) for cache busting.

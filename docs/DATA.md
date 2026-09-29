# Data — ASCII Atlas

The pipeline and schemas are city-agnostic. Each city gives its inputs through a city pack (`packages/content/cities/<slug>/`). City-specific research and data notes live in the city briefs (`docs/cities/`). Examples use Naga, the first city.

## 1. Sources

| Source | Used for | License / terms | Notes |
|---|---|---|---|
| OpenStreetMap (Overpass API or the Geofabrik extract for the city's country) | Roads, buildings, water, landuse, POIs, admin boundaries | ODbL — attribution "© OpenStreetMap contributors" required; derived databases must stay ODbL | Primary modern layer |
| OpenHistoricalMap | Dated historical features | CC0 | Check coverage for each city; contribute back |
| Copernicus DEM GLO-30 (or SRTM) | Terrain shading at Region level | Copernicus: free with attribution | Global coverage |
| Esri World Imagery Wayback | Satellite snapshots by year (~2014+) | Esri terms — verify that deriving ASCII underlays is allowed before shipping; otherwise use Sentinel-2 | Timeline underlay |
| Sentinel-2 (Copernicus) | Satellite underlay 2015+ | Free with attribution | 10 m resolution; district-level only |
| Landsat (USGS) | Urban growth 1980s+ | Public domain | 30 m; City/Region level only |
| Mapillary / KartaView | Street-level photos in the info panel | CC BY-SA | Link out or embed per their terms |
| Archival maps, photos, records (local libraries, universities, parish archives, private collections) | Historical layers, stories, then/now photos | Per item — record permission in content | Must have written permission for anything not public domain |

**Do not use** Google Maps or Street View tiles or imagery.

## 2. Pipeline (`pnpm data:build`)

All scripts live in `packages/data/scripts`. `pnpm data:build -- --city <slug>` builds one city. With no `--city`, it builds every city in the registry (every folder in `packages/content/cities/` with a valid `city.json`). Each step reads from the previous step's output in `packages/data/build/<city>/`, and each is idempotent.

1. **`01-fetch`**
   - Read `city.json`, then download OSM data for two bounding boxes:
     - **Detail bbox:** the city boundary plus the configured buffer (`detail_buffer_km`). The boundary relation is found via Overpass using the config's `boundary` lookup (name, admin_level, and parent area). Fail loudly if the lookup matches zero relations or more than one.
     - **Region bbox:** the configured `region`, fetched with low-detail filters only (coastline, major roads, water, place nodes). A whole region is too much for one Overpass request, so each heavy layer is fetched per quarter of the region (cached separately) and the results are merged into `region.osm.json`.
   - Download DEM tiles for the Region bbox.
   - Cache raw downloads in `raw/<city>/`, and skip a download if the file is fresh (under 7 days old, or when `--offline` is set).
2. **`02-convert`**
   - OSM → GeoJSON (`osmtogeojson`, or `ogr2ogr` / `osmium export` for PBF).
   - DEM → hillshade/luminance raster (`gdaldem hillshade`) → grayscale PNG tiles.
3. **`03-normalize`**
   - Map OSM tags to atlas classes (see section 3).
   - Drop untagged or irrelevant features.
   - Compute building `height` (`height` tag, else `building:levels × 3`, else a class default) for features with `building=*` only. Grounds that share a building class (e.g. `amenity=school` on a campus polygon) get no height.
   - Assign stable ids: `osm:<type>/<id>`.
   - Compute `subdivision` for each feature by point-in-polygon against the boundaries at the city's `subdivision.admin_level`. Only mapped boundary polygons count; features outside them get no subdivision (see the city brief for coverage, e.g. `naga.md` §5).
4. **`04-merge-content`**
   - Load and validate the city's pack (`packages/content/cities/<slug>/`) with zod, including checking that localized fields use only the city's declared languages.
   - Join curated records to features by `osm_id`, or add standalone features for demolished or historical things that OSM doesn't have.
   - Write `start_year`, `end_year`, `certainty`, `name_history`, `landmark: true`, and `story_id` into properties.
   - Give named landmarks and monuments a label anchor (`label_lng`, `label_lat`: a point's position or an area's centroid), computed before tiling so labels land in the same place in every tile.
5. **`05-tiles`**
   - Run tippecanoe (or Planetiler), with one layer per class group: `water, roads, buildings, landuse, poi, admin, labels, events`.
   - Zoom ranges: Region layers z6–z11; detail layers z12–z16 (overzoom to z19 in the client).
   - Output `<city>.pmtiles` (via `pmtiles convert` if needed) and copy it to `apps/web/public/tiles/`.
   - Write `<city>.meta.json` (see `ARCHITECTURE.md` §2): bounds derived from the boundary, the default camera (the `focus` feature, else the boundary centroid), the region bounds, the subdivision label, languages, the year range from dated features, and attribution.
6. **`06-search-index`**
   - Build `<city>.search-index.json` from normalized features plus content, including alt names and name history.

Required CLI tools: `tippecanoe`, `gdal`, and optionally `osmium-tool` and the `pmtiles` CLI. Document the install steps in `packages/data/README.md`. Consider a Dockerfile so the pipeline is reproducible.

## 3. Class mapping (starter)

| Atlas class | OSM tags |
|---|---|
| `water_river` | `waterway=river` (from the City level) |
| `water_stream` | `waterway=stream|canal` (from the District level) |
| `water_area` | `natural=water`, `water=*`, `waterway=riverbank`; `natural=coastline` (processed into sea polygons, with the Region layers in Phase 2) |
| `road_major` | `highway=motorway|trunk|primary` (+ `_link`) |
| `road_mid` | `highway=secondary|tertiary` (+ `_link`) |
| `road_minor` | `highway=residential|unclassified|service|living_street` |
| `path` | `highway=footway|path|pedestrian|steps|track` |
| `building` | `building=*` |
| `building_religious` | `building=church|cathedral|chapel` or `amenity=place_of_worship`; `landuse=religious` grounds (no height) |
| `building_school` | `amenity=school|university|college` (area or building) |
| `building_market` | `amenity=marketplace`, `shop=mall|supermarket` |
| `park` | `leisure=park|garden|playground`, `place=square` |
| `trees` | `natural=wood`, `landuse=forest` |
| `farmland` | `landuse=farmland|paddy` / `crop=rice` |
| `monument` | `historic=monument|memorial`, `memorial=statue|bust`, `tourism=artwork` |
| `building_part` | not from OSM tags: plan-view landmark parts from the city pack's `plans/` (pipeline step 04) |
| `tree` | `natural=tree` (points), `natural=tree_row` (lines) |
| `barrier` | `barrier=fence|wall|hedge|gate` (kind in `variant`) |
| `entrance` | `entrance=*` |
| `furniture` | `amenity=bench|fountain`, `man_made=flagpole` (kind in `variant`) |
| `parking` | `amenity=parking` |
| `pitch` | `leisure=pitch` |

Roads also carry `width` (meters: the `width` tag, else `lanes` × 3.2, else 14 / 10 / 6 m for major / mid / minor), and buildings with `roof:shape` carry it as `variant`.
| `admin_city` | the city's boundary relation (from `city.json`; admin_level 6 for Naga) |
| `admin_subdivision` | boundaries at the city's `subdivision.admin_level` (10 for Naga's barangays) |
| `place_label` | named `place=city|town|village|suburb|quarter|neighbourhood` nodes |

## 4. Content schemas (defined in `packages/shared`)

```ts
City {                           // cities/<slug>/city.json
  slug: string;                  // "naga", also the route and file prefix
  name: LocalizedText;
  country: string;               // ISO 3166-1 alpha-2, e.g. "PH"
  boundary: { name: string; admin_level: number; within?: string };  // Overpass lookup
  detail_buffer_km: number;
  region: { name: string; osm_relation?: string } | { bbox: [number, number, number, number] };
  subdivision: { admin_level: number; label: LocalizedText };        // e.g. 10, "barangay"
  languages: string[];           // extra content languages besides "en", e.g. ["fil", "bcl"]
  smoke_landmark: string;        // name the e2e test searches for
  focus?: { osm_id: string; zoom: number };  // where the city opens, e.g. its main plaza
}

LocalizedText = { en: string } & { [lang: string]: string };  // keys limited to "en" + city.languages

Landmark {
  id: string;                    // "landmark/<slug-of-name>", unique within the city
  osm_id?: string;               // "osm:way/123456" — join key
  geometry?: GeoJSON;            // only if not in OSM (e.g. demolished)
  name: LocalizedText;
  type: 'church' | 'school' | 'plaza' | 'market' | 'government' | 'bridge' | 'monument' | 'other';
  start_year?: number;
  end_year?: number;
  certainty: 'exact' | 'circa' | 'unknown';
  story?: LocalizedText;         // markdown
  photos?: { src: string; year?: number; caption?: string; credit: string; license: string }[];
  sources: { title: string; url?: string; note?: string }[];   // required, min 1
}

NameHistory {
  osm_id: string;
  names: { name: string; from?: number; to?: number; certainty: 'exact' | 'circa' }[];
  sources: Source[];
}

Event {
  id: string;
  year: number;
  date?: string;                 // ISO if known
  lat: number; lng: number;
  title: LocalizedText;
  story: LocalizedText;
  sources: Source[];
}

Tour {                           // cities/<slug>/tours/*.json
  id: string;                    // "tour/<slug>"
  title: LocalizedText;
  description?: LocalizedText;
  status: 'draft' | 'verified';  // verified: no "TODO(verify)", and sources on every step
  steps: {
    camera: { lat: number; lng: number; zoom: number; pitch: number; bearing: number };
    duration_ms: number;         // how long the step holds after the camera arrives
    fly_ms?: number;             // flight duration (≤ 15 s); default: the 0.8–3 s fly-to rule
    narration: LocalizedText;
    year?: number;
    select?: string;             // feature id, "osm:<type>/<id>"
    highlight?: string[];        // feature ids, at most 64
    audio?: string;
    sources?: Source[];
  }[];
}
```

LandmarkPlan {                   // cities/<slug>/plans/*.json — drawn on the map, from above
  id: string;                    // "plan/<slug>"
  osm_id: string;                // the landmark or monument
  title: string;
  front?: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';   // area features
  parts: {
    kind: 'dome' | 'cupola' | 'belfry' | 'tower' | 'tier' | 'pedestal';
    shape: 'circle' | 'hexagon' | 'square';
    size_m: number; height_m: number;
    at?: { along: number; across: number };  // areas: -1 back … +1 front; -1 left … +1 right seen from the front
    offset_m?: [number, number];              // points: meters east, north
  }[];
  status: 'draft' | 'verified';
  sources: Source[];
}

LandmarkArt {                    // cities/<slug>/art/*.json — front views for the info panel, not the map
  id: string;                    // "art/<slug>"
  osm_id: string;                // the landmark or monument it draws
  title: string;
  variants: { rows: string[]; colors: string[] }[];  // smallest first; colors: palette keys per character
  palette: Record<string, 'stone' | 'wall' | 'roof' | 'wood' | 'gold' | 'glass' | 'foliage' | 'accent'>;
  footprint_m?: number;          // width in meters, for point features
  priority?: number;             // wins when drawings would overlap
  status: 'draft' | 'verified';  // draft until someone who knows the place has checked it
  sources: Source[];             // the reference photos and pages it was drawn from
}

Validation rules:
- `sources` is non-empty for any record with a year or story, and for every art piece.
- Art rows in a variant have equal widths, use only `ART_CHARACTERS`, and have a color row of the same shape whose keys are in the palette. Pipeline step 04 checks that each art piece's `osm_id` is in the data and writes `<city>.art.json`.
- Localized fields contain `en` and only the languages listed in the city's `languages`.
- A `region` bbox is the only coordinate data allowed in a city config, and only when the region has no usable OSM relation. The boundary and camera always come from OSM: the default camera is centered on the `focus` feature, or on the boundary centroid when there is no `focus`.
- `end_year > start_year`.
- Photo `credit` and `license` are required.

## 5. Dating historical features — rules

- **Edit dates aren't build dates.** Never infer `start_year` from OSM edit history. OSM `start_date` tags may be used when present, with `certainty` derived from their format: `1954` → exact, `~1950` or `1950s` → circa.
- **Undated means always present.** Modern features without dates have no `start_year`. The UI legend explains that undated features show in all years.
- **Demolished features** go in content as standalone geometry. They are traced from old maps or imagery, with the tracing source recorded.
- **Old maps** are georeferenced in QGIS (Georeferencer) or Allmaps, exported as COG/XYZ, and listed in `content/cities/<slug>/historic-maps/*.json`, which records the year range covered, the source, and the permission.

## 6. Attribution (always visible in the UI)

"© OpenStreetMap contributors" is always shown. The other credits are added only when their layer is active:
- DEM: "Copernicus DEM"
- Satellite underlays: "Esri Wayback" or "Copernicus Sentinel-2"
- Each photo and historic map: its own credit, in the info panel

## 7. Research backlog

Each city keeps its own research backlog in its brief (Naga: `docs/cities/naga.md` §4). Record each item in that city's pack with its sources.

## 8. Adding a city

Adding a city needs no renderer or web app changes. If it seems to, the engine has a city-specific assumption, and that should be fixed in the engine.

1. Write a brief at `docs/cities/<slug>.md`, using `naga.md` as the template: config table, zoom-level notes, tour launch set, research backlog, and data notes.
2. Create `packages/content/cities/<slug>/city.json` and the empty content folders.
3. Check the boundary lookup: it must match exactly one relation, and the subdivision `admin_level` must match how that country tags its subdivisions.
4. Run `pnpm data:build -- --city <slug>`, then check the output: tile size is within budget, and meta bounds and default camera look right.
5. Add at least the smoke landmark and one establishing tour, with sources.
6. Run `pnpm --filter @atlas/content validate` and `pnpm test:e2e`. The e2e suite picks up every registered city.
7. Add any extra attribution the city's sources need (§6).

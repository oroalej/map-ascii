# Data — ASCII Atlas

The pipeline and schemas are city-agnostic. Each city gives its inputs through a city pack (`packages/content/cities/<slug>/`). City-specific research and data notes live in the city briefs (`docs/cities/`). Examples use Naga, the first city.

## 1. Sources

| Source | Used for | License / terms | Notes |
|---|---|---|---|
| OpenStreetMap (Overpass API or the Geofabrik extract for the city's country) | Roads, buildings, water, landuse, POIs, admin boundaries | ODbL — attribution "© OpenStreetMap contributors" required; derived databases must stay ODbL | Primary modern layer |
| OpenHistoricalMap | Dated historical features | CC0 | Check coverage for each city; contribute back |
| Copernicus DEM GLO-30 (or SRTM) | Terrain shading at Region level | Copernicus: free with attribution | Global coverage |
| Esri World Imagery Wayback | Satellite snapshots by year (~2014+) | Esri terms — verify that deriving ASCII underlays is allowed before shipping; otherwise use Sentinel-2 | Timeline underlay; tracing curated trees and land cover that OSM lacks (`landcover/`, credited in the attribution; same terms check) |
| Sentinel-2 (Copernicus) | Satellite underlay 2015+ | Free with attribution | 10 m resolution; district-level only |
| Landsat (USGS) | Urban growth 1980s+ | Public domain | 30 m; City/Region level only |
| Mapillary / KartaView | Street-level photos in the info panel | CC BY-SA | Link out or embed per their terms |
| Archival maps, photos, records (local libraries, universities, parish archives, private collections) | Historical layers, stories, then/now photos | Per item — record permission in content | Must have written permission for anything not public domain |

**Do not use** Google Maps or Street View tiles or imagery.

## 2. Pipeline (`pnpm data:build`)

All scripts live in `packages/data/scripts`. `pnpm data:build -- --city <slug>` builds one city. With no `--city`, it builds every city in the registry (every folder in `packages/content/cities/` with a valid `city.json`). Each step reads from the previous step's output in `packages/data/build/<city>/`, and each is idempotent.

1. **`01-fetch`**
   - Read `city.json`, then download OSM data for two bounding boxes:
     - **Detail bbox:** the city boundary plus the configured buffer (`detail_buffer_km`). The boundary relation is found via Overpass using the config's `boundary` lookup (name, admin_level, and parent area). Fail loudly if the lookup matches zero relations or more than one. The detail bbox is then clipped to the region bounds, because the camera can't leave the region. The search index likewise drops entries outside the region.
     - **Region bbox:** the configured `region`, fetched with low-detail filters only (coastline, major roads, railways, water, place nodes). A whole region is too much for one Overpass request, so each heavy layer is fetched per quarter of the region (cached separately) and the results are merged into `region.osm.json`.
     - **Railways** (track and stations in the detail bbox) are a small query of their own, saved as `detail-rail.osm.json`, and the region's railway queries come after its other parts. Adding them left the big saved downloads valid, and the servers answer the small query when the big one times out. `overpass()` retries 5xx answers and dropped connections, rotating through three public instances (`OVERPASS_URL` pins one).
   - Download DEM tiles for the Region bbox.
   - Save raw downloads in `raw/<city>/` (gitignored) and keep them until `--refresh`: they never expire. A saved download is reused for the same query, or for the same query over a bbox inside the saved one (step 03 drops features wholly outside the region). `--offline` never downloads.
   - Transit stops, terminals, shelters, and covered entrances are fetched separately into `detail-life.osm.json`. Step 02 merges that optional download with the detail data; older cached downloads remain usable. Step 03 writes `life_site`, `life_modes` (bus 1, jeepney 2, tricycle 4), `life_covered`, and a stable `life_lng`/`life_lat` anchor. Rail and ferry platforms are excluded. Site metadata is retained from tile zoom 13 even while furniture glyphs stay hidden at smaller display zooms.
2. **`02-convert`**
   - OSM → GeoJSON (`osmtogeojson`, or `ogr2ogr` / `osmium export` for PBF). The railway download is merged into the detail download first (if there is one).
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
   - Add the pack's curated `landcover/` (trees, tree rows, and grass, parking, or woods areas that OSM doesn't map yet) as features of their class (`tree`; areas as `grass`, `parking`, `trees`) with ids `cover:<slug>/<tree|row|area>-<n>`, trees sized and kinded by the same rules as OSM trees. A curated tree with an OSM tree within 3 m is dropped with a warning to remove it from the pack; OSM areas of a curated area's class inside it are flagged.
   - Write `start_year`, `end_year`, `certainty`, `name_history`, `landmark: true`, and `story_id` into properties.
   - Merge sourced outdoor `details/` (`SiteDetail`) onto an existing OSM area. `surface: "paving"` changes its ground class while retaining its id, labels, and landmark metadata. Authored `walks` are simulation routes, not painted lines; `seating` becomes rounded, real-width stone footprints and sparse bench pause anchors on their accessible side; `lamps` becomes static multi-head hardware. Stable item ids survive record reordering. Reject missing/duplicate parents, buildings, out-of-bounds geometry, and routes across raised beds or monument parts; mapped benches and lamps within 3 m suppress curated duplicates. Credits join the generated meta attribution.
   - Give named landmarks and monuments a label anchor (`label_lng`, `label_lat`: a point's position or an area's centroid), computed before tiling so labels land in the same place in every tile.
5. **`05-tiles`**
   - Run tippecanoe (or Planetiler), with one layer per class group: `water, roads, buildings, landuse, poi, admin, labels, events`.
   - Zoom ranges: Region layers z6–z11; detail layers z12–z16 (overzoom to z19 in the client).
   - Output `<city>.pmtiles` (via `pmtiles convert` if needed) and copy it to `apps/web/public/tiles/`.
   - Write `<city>.meta.json` (see `ARCHITECTURE.md` §2): bounds derived from the boundary, the default camera (the `focus` feature, else the boundary centroid), the region bounds, the subdivision label, languages, the year range from dated features, and attribution.
6. **`06-search-index`**
   - Build `<city>.search-index.json` from normalized features plus content, including alt names and name history.
7. **`07-processions`**
   - For each of the pack's `processions`, follow the rivers (`water_river`, in the direction OSM draws them, which is the way they flow) from the start down to the landing: the shortest river path from `route.from`, or `route.upstream_m` meters upstream of `route.to`, keeping to the river of the same name at confluences. Both ends must lie within 300 m of a river; the route ends at the river point nearest each (an end may be a landmark a short walk from the river).
   - Resample the route to points at most 10 m apart and measure, at each, how far the water reaches to its left and right (`banks`, from the `water_area` polygons; left out where the river is mapped only as a line).
   - Write `<city>.processions.json` (the `CityProcessions` schema), published with the tiles. Cities without processions get no file.

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
| `rail` | `railway=rail|narrow_gauge|light_rail`, sidings and yards included (disused and abandoned track isn't fetched); `service=siding|spur|yard` goes in `variant` (trains stand by there) |
| `building` | `building=*` |
| `building_religious` | `building=church|cathedral|chapel` or `amenity=place_of_worship`; `landuse=religious` grounds (no height) |
| `building_school` | `amenity=school|university|college` (area or building) |
| `building_market` | `amenity=marketplace`, `shop=mall|supermarket` |
| `building_station` | `building=train_station`, `railway=station|halt`, or `public_transport=station` with `train=yes` or a `railway` tag (area or point) |
| `park` | `leisure=park|garden|playground`, `place=square` |
| `paving` | a sourced `details/` ground-surface override on an existing OSM area |
| `trees` | `natural=wood`, `landuse=forest` (kind in `variant`) |
| `grass` | `landuse=grass|meadow|village_green`, `natural=grassland`, `leisure=recreation_ground` (a park wins if both are tagged) |
| `farmland` | `landuse=farmland|paddy` / `crop=rice` |
| `monument` | `historic=monument|memorial`, `memorial=statue|bust`, `tourism=artwork` |
| `building_part` | not from OSM tags: plan-view landmark parts from the city pack's `plans/` (pipeline step 04) |
| `tree` | `natural=tree` (points), `natural=tree_row` (lines) (kind in `variant`; `height` and `crown`); also the city pack's curated `landcover/` trees and rows (pipeline step 04); its areas are `grass`, `parking`, or `trees` |
| `barrier` | `barrier=fence|wall|hedge|gate` (kind in `variant`) |
| `entrance` | `entrance=*` |
| `furniture` | `amenity=bench|fountain|shelter|bus_station`, `highway=bus_stop|street_lamp`, road transport platforms, sourced tricycle ranks, `man_made=flagpole` (kind in `variant`; shelters with buildings keep their building class) |
| `parking` | `amenity=parking` |
| `pitch` | `leisure=pitch` |

Roads also carry `width` (meters: the `width` tag, else `lanes` × 3.2, else 14 / 10 / 6 m for major / mid / minor), and buildings with `roof:shape` carry it as `variant`. Trees and woods carry their kind as `variant`: `palm` when `genus`, `species`, `species:en`, or `taxon` names a palm (OSM's `leaf_type` has no palm value), else `leaf_type` (`needleleaved` or `broadleaved`). Trees also carry `height` and `crown` (crown diameter) in meters: the `height` and `diameter_crown` tags, else a typical size for the kind (10 / 8 m, palms 12 / 6 m, needleleaved 12 / 5 m).
| `admin_city` | the city's boundary relation (from `city.json`; admin_level 6 for Naga) |
| `admin_subdivision` | boundaries at the city's `subdivision.admin_level` (10 for Naga's barangays) |
| `place_label` | named `place=city|town|village|suburb|quarter|neighbourhood` nodes |

### Street enrichment

Road normalization reads `sidewalk`, `sidewalk:both`, `sidewalk:left`, and `sidewalk:right`. Side-specific tags override `sidewalk:both`, which overrides the general tag; `no`, `none`, and `separate` suppress the band on that side. Widths use `sidewalk:width`, then `sidewalk:both:width`, with side-specific widths overriding each side independently; the fallback is 2 m. Tiles retain `sidewalk`, `sidewalk_width`, `sidewalk_left_width`, `sidewalk_right_width`, and `sidewalk_src: "mapped"`. Left/right follow the original OSM way direction; in downward-positive tile coordinates the left normal is `(dy, -dx)`.

Step 04 may add both sidewalks to untagged, non-region `road_major` and `road_mid` features at 2 m per side, with `sidewalk_src: "derived"`. `city.streets.sidewalks.derive` defaults to true; an explicit sidewalk policy requires a nonempty `source`. A false policy keeps mapped bands only. The legend receives this policy from the city pack. Logs report sidewalk-side kilometers separately from the road kilometers they cover. Naga explicitly disables derivation pending a sourced survey.

`oneway=yes|true|1` becomes 1, `oneway=-1|reverse` becomes -1, and `no|reversible|alternating` becomes 0. Without an explicit `oneway`, `junction=roundabout|circular` implies 1; other roads default to 0. Nonzero direction is retained in tiles and carried on life polylines for future routing; current simulated traffic behavior is unchanged. Arrow anchors are baked from complete original segments before tippecanoe clips them. Their world-meter phase gives 30 m spacing, with an 8 m exclusion at real segment vertices; tile seams do not restart the phase or add exclusions. The worker draws each anchor as an exact 3 m by at most 3 m quad.

The small traffic query also fetches `highway=stop` nodes. Resolved signals generate stop lines on inbound approaches only, at `signal_radius + 1.5 m` from the shared vertex; outgoing one-way arms and approaches shorter than the setback are skipped. Two-way lines cover half the road, centered one quarter-width to the right of travel; one-way lines cover the full road. Driving side currently defaults to right: the city schema has no driving-side setting. Mapped stop nodes must match a road vertex. A `direction=forward|backward` sign resolves one approach; at an ambiguous shared vertex the lowest road rank, then narrower width and stable id resolve the tie. An undirected junction sign covers approaches of the lowest-ranked road; undirected mid-block nodes are skipped and counted. Coincident lines are deduplicated, preferring mapped provenance. Stop anchors carry `stop_bearing`, `stop_width`, `stop_road`, and `stop_src`; they produce an exact 0.5 m long quad and never a point glyph. Positions, line dimensions and arrow spacing are illustrative rather than surveyed road paint.

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
  // The life layer's vehicle mix: per road class, relative weights of car, motorcycle,
  // tricycle, jeepney, bus, and truck. A road class left out uses the default mix.
  // `river`: boats (rowboat, motorboat, banca); `parked`: vehicles in lots and along curbs.
  traffic?: { road_major?: Weights; road_mid?: Weights; road_minor?: Weights; river?: BoatWeights; canal?: BoatWeights; parked?: Weights };
  // The wind by season (SPEC.md §4 "Wind"): each season's months (1–12, each in at most one
  // season), where the wind blows from (compass degrees) and how hard; `default` for the other
  // months; `source` for where the seasons come from. Without it: a breeze from the east.
  climate?: {
    wind: { name?: string; months: number[]; from: number; strength: WindStrength }[];
    default: { from: number; strength: WindStrength };
    source: string;
  };
  // The city's IANA time zone, e.g. "Asia/Manila": the life layer's clock, fixed times of day,
  // and seasons follow it. Without it: the sun's time at the city's longitude.
  timezone?: string;
  // Street enrichment. An explicit sidewalk policy requires its decision/survey source.
  streets?: { sidewalks?: { derive?: boolean; source: string } }; // derive defaults to true
  // The daily rhythm (SPEC.md §4 "Time of day"): per kind (vehicle, person, boat, train), how
  // much is out over the local day, as [hour 0–24, share 0–1] points, hours ascending, read
  // straight between points and across midnight. A kind left out uses DEFAULT_RHYTHM.
  life?: {
    // Source each mode override or missing site. Give exactly one of osm_id or position.
    sites?: {
      id: string; kind: 'stop' | 'terminal' | 'shelter';
      osm_id?: string; position?: [lng, lat];
      modes?: ('bus' | 'jeepney' | 'tricycle')[]; // required for stops and terminals
      covered?: boolean; source: string;
    }[];
    rhythm?: { vehicle?: [number, number][]; person?: ...; boat?: ...; train?: ... };
    // When places fill up (SPEC.md §4 "Places"). Weekdays 0 = Sunday; times local HH:MM.
    // Without `worship`, churches only have a few visitors; without `school`, weekdays 07:00–16:00.
    schedules?: {
      worship?: { weekdays: number[]; times: string[] }[];
      school?: { weekdays: number[]; in: string; out: string };
    };
    source: string;
  };
}

WindStrength = "calm" | "breeze" | "gusty" | "storm";

LocalizedText = { en: string } & { [lang: string]: string };  // keys limited to "en" + city.languages
Weights = { car?: number; motorcycle?: number; tricycle?: number; jeepney?: number; bus?: number; truck?: number; bicycle?: number };  // ≥ 0, at least one > 0
BoatWeights = { rowboat?: number; motorboat?: number; banca?: number };  // ≥ 0, at least one > 0

Landmark {
  id: string;                    // "landmark/<slug-of-name>", unique within the city
  osm_id?: string;               // "osm:way/123456" — join key
  geometry?: GeoJSON;            // only if not in OSM (e.g. demolished)
  name: LocalizedText;
  type: 'church' | 'school' | 'plaza' | 'market' | 'government' | 'bridge' | 'station' | 'monument' | 'other';
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

Procession {                     // cities/<slug>/processions/*.json
  id: string;                    // "procession/<slug>"
  title: LocalizedText;
  story: LocalizedText;          // may hold "TODO(verify)" while draft
  status: 'draft' | 'verified';  // verified: no "TODO(verify)", and sources
  kind: 'fluvial';
  route: { to: string; from?: string; upstream_m?: number };  // OSM ids; exactly one of from / upstream_m
  schedule: {                    // offset_days after the nth weekday (0 = Sunday) of month
    month: number; weekday: number; nth: number; offset_days: number;
    start: string;               // "HH:MM", local
    duration_min: number;
    timezone: string;            // IANA, e.g. "Asia/Manila"
  };
  formation?: { columns?: number; ranks?: number; escorts?: number };
  sources?: Source[];
}

Tour {                           // cities/<slug>/tours/*.json
  id: string;                    // "tour/<slug>"
  title: LocalizedText;
  description?: LocalizedText;
  status: 'draft' | 'verified';  // verified: no "TODO(verify)", and sources on every step
  steps: {
    camera: { lat: number; lng: number; zoom: number };  // flat and north-up; no other keys
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

Landcover {                      // cities/<slug>/landcover/*.json — trees and ground cover OSM doesn't map yet
  id: string;                    // "landcover/<slug>"
  title: string;
  trees?: { at: [lng, lat]; kind?: TreeKind; crown_m?: number; height_m?: number }[];
  rows?: { line: [lng, lat][]; kind?: TreeKind; crown_m?: number; height_m?: number }[];
  areas?: { ring: [lng, lat][]; cover: 'grass' | 'parking' | 'woods'; kind?: TreeKind }[];  // closed ring; kind: woods only
  status: 'draft' | 'verified';  // draft until checked on the ground or against newer imagery
  credit: string;                // shown with the map attribution, e.g. the traced imagery
  sources: Source[];
}
TreeKind = 'broadleaved' | 'palm' | 'needleleaved';   // unset: the generic tree

SiteDetail {                     // cities/<slug>/details/*.json — sourced outdoor detail
  id: string;                    // "detail/<slug>"
  osm_id: string; title: string; surface: 'paving';
  walks: { id: string; line: [lng, lat][]; width_m: number }[];
  seating: { id: string; line: [lng, lat][]; width_m: number; height_m: number; facing: 'left' | 'right' }[];
  lamps: { id: string; at: [lng, lat]; bearing: number; reach_m: number; heads: number }[];
  status: 'draft' | 'verified'; credit: string; sources: Source[];
}
// CuratedArea also accepts raised?: boolean for planting beds ground agents cannot enter.

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
- Coordinates in a city config are limited to a `region` bbox without a usable OSM relation and independently sourced `life.sites` missing from OSM. Prefer an `osm_id` for a mapped site; a missing reference fails the merge. The boundary and camera always come from OSM: the default camera is centered on the `focus` feature, or on the boundary centroid when there is no `focus`.
- `end_year > start_year`.
- Photo `credit` and `license` are required.
- A land cover file has at least one tree, row, or area, a `credit`, and `sources` naming what it was traced from. Positions come from imagery whose terms allow it (never Google), and each file retires as OSM maps what it holds (pipeline step 04 warns). Prefer separate trees to a woods area where crowns are distinguishable: at close zoom a woods area draws as one continuous canopy.

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
8. Publish the tiles with `pnpm data:publish -- --city <slug>` and commit the `tiles.lock.json` it writes (§9), so CI and deploys have them.

## 9. Publishing tiles

Generated files are gitignored (never commit tiles), so builds get them from GitHub releases instead:

- `pnpm data:publish [-- --city <slug>]` uploads a city's `apps/web/public/tiles/<slug>.*` (the output of `pnpm data:build`) as a new release `tiles-<slug>-<YYYYMMDD-HHMM>` (not marked latest), then writes `packages/content/cities/<slug>/tiles.lock.json`: the repository, the tag, and each file's sha256. Commit the lock. It needs the GitHub CLI logged in with write access, and does nothing if the files match the current lock.
- `pnpm data:fetch [-- --city <slug>] [--force]` downloads each locked city's missing files and checks each against its sha256 before writing it. Files that exist but differ from the lock (a local rebuild) are kept with a warning, unless `--force`. A city without a lock only warns. The web app's `build` fetches before rebuilding; unchanged exports skip both fetching and building. CI and Vercel fetch missing tiles on their own.
- Downloads use `GITHUB_TOKEN` (or `GH_TOKEN`, or the GitHub CLI's login). A private repository needs one: CI passes the workflow's token, and the Vercel project needs a read-only token in its environment.
- The lock is validated with the city pack (`TilesLock` in `packages/shared`).
### Traffic enrichment

`01-fetch` saves a separate `detail-traffic.osm.json` node query for `highway=traffic_signals|crossing|stop`, `crossing`, and `crossing:markings`, preserving existing download caches. Tagged nodes win over skeletal way members when responses merge. Marked crossing nodes and signals use furniture variants; `footway=crossing` ways keep their path class and receive point stripe anchors in `lib/traffic.ts`. That resolver uses exact shared road vertices, snaps mapped signals within 30 m, derives signals only at four-arm mid/major intersections, suppresses nearby duplicates, and adds crossing anchors on their approaches. Tiles carry crossing bearing/width/road and signal axes/radius/provenance from z15. `life.signals` supports `derive`, sourced `add` positions, and sourced `remove` targets by node ID or position. Phases and derived crossings are simulated, not surveyed traffic timings.

### Neighborhood enrichment

The separate `detail-neighborhood.osm.json` query fetches shops, selected food/service amenities, craft, scrub/heath, orchards, plant nurseries and cemeteries. `03-normalize` runs `lib/frontage.ts` while raw tags and building polygons still exist: a bbox grid and polygon containment associate shop nodes with footprints, including holes. Food wins over service, retail and generic commercial tags. Assigned nodes are suppressed as standalone markers; embedded malls/supermarkets retain the market class and contribute their names to unnamed footprints. Other shop points use furniture variants `shop_food`, `shop_retail`, `shop_service`; building roof variants stay intact. Tiles carry `frontage` as a separate property. The worker packs frontage/kind bits without adding classes, caps shop lights and buffered commerce centers at 150 per tile, and transfers commerce separately for deterministic additive spawning.

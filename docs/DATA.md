# Data — Naga Atlas

## 1. Sources

| Source | Used for | License / terms | Notes |
|---|---|---|---|
| OpenStreetMap (Overpass API or Geofabrik Philippines extract) | Roads, buildings, water, landuse, POIs, admin boundaries | ODbL — attribution "© OpenStreetMap contributors" required; derived databases must stay ODbL | Primary modern layer |
| OpenHistoricalMap | Dated historical features | CC0 | Check coverage for Naga; contribute back |
| Copernicus DEM GLO-30 (or SRTM) | Terrain shading at Region level | Copernicus: free with attribution | Mt. Isarog relief |
| Esri World Imagery Wayback | Satellite snapshots by year (~2014+) | Esri terms — verify that deriving ASCII underlays is allowed before shipping; otherwise use Sentinel-2 | Timeline underlay |
| Sentinel-2 (Copernicus) | Satellite underlay 2015+ | Free with attribution | 10 m resolution; district-level only |
| Landsat (USGS) | Urban growth 1980s+ | Public domain | 30 m; City/Region level only |
| Mapillary / KartaView | Street-level photos in the info panel | CC BY-SA | Link out or embed per their terms |
| Archival maps, photos, records (local libraries, universities, parish archives, private collections) | Historical layers, stories, then/now photos | Per item — record permission in content | Must have written permission for anything not public domain |

**Do not use** Google Maps or Street View tiles or imagery.

## 2. Pipeline (`pnpm data:build`)

All scripts live in `packages/data/scripts`. Each step reads from the previous step's output in `packages/data/build/`, and each is idempotent.

1. **`01-fetch`**
   - Download OSM data for the bounding boxes:
     - **Naga detail bbox:** Naga City boundary + 2 km buffer. The boundary is found via Overpass: `relation["boundary"="administrative"]["name"="Naga"]["admin_level"="6"]` in Camarines Sur; verify the admin_level against the data.
     - **Region bbox:** Bicol peninsula, fetched with low-detail filters only (coastline, major roads, water, place nodes).
   - Download DEM tiles for the Region bbox.
   - Cache raw downloads in `raw/`, and skip a download if the file is fresh (under 7 days old, or when `--offline` is set).
2. **`02-convert`**
   - OSM → GeoJSON (`osmtogeojson`, or `ogr2ogr` / `osmium export` for PBF).
   - DEM → hillshade/luminance raster (`gdaldem hillshade`) → grayscale PNG tiles.
3. **`03-normalize`**
   - Map OSM tags to atlas classes (see section 3).
   - Drop untagged or irrelevant features.
   - Compute building `height` (`height` tag, else `building:levels × 3`, else a class default).
   - Assign stable ids: `osm:<type>/<id>`.
   - Compute `barangay` for each feature by point-in-polygon against the admin_level 10 boundaries.
4. **`04-merge-content`**
   - Load and validate `packages/content` with zod.
   - Join curated records to features by `osm_id`, or add standalone features for demolished or historical things that OSM doesn't have.
   - Write `start_year`, `end_year`, `certainty`, `name_history`, `landmark: true`, and `story_id` into properties.
5. **`05-tiles`**
   - Run tippecanoe (or Planetiler), with one layer per class group: `water, roads, buildings, landuse, poi, admin, labels, events`.
   - Zoom ranges: Region layers z6–z11; detail layers z12–z16 (overzoom to z19 in the client).
   - Output `naga.pmtiles` (via `pmtiles convert` if needed) and copy it to `apps/web/public/tiles/`.
6. **`06-search-index`**
   - Build `search-index.json` from normalized features plus content, including alt names and name history.

Required CLI tools: `tippecanoe`, `gdal`, and optionally `osmium-tool` and the `pmtiles` CLI. Document the install steps in `packages/data/README.md`. Consider a Dockerfile so the pipeline is reproducible.

## 3. Class mapping (starter)

| Atlas class | OSM tags |
|---|---|
| `water_river` | `waterway=river|stream|canal` |
| `water_area` | `natural=water`, `water=*`, `natural=coastline` (processed into sea polygons) |
| `road_major` | `highway=motorway|trunk|primary` (+ `_link`) |
| `road_mid` | `highway=secondary|tertiary` (+ `_link`) |
| `road_minor` | `highway=residential|unclassified|service|living_street` |
| `path` | `highway=footway|path|pedestrian|steps|track` |
| `building` | `building=*` |
| `building_religious` | `building=church|cathedral|chapel` or `amenity=place_of_worship` |
| `building_school` | `amenity=school|university|college` (area or building) |
| `building_market` | `amenity=marketplace`, `shop=mall|supermarket` |
| `park` | `leisure=park|garden|playground`, `place=square` |
| `trees` | `natural=wood`, `landuse=forest` |
| `farmland` | `landuse=farmland|paddy` / `crop=rice` |
| `admin_city` | admin_level 6 boundary for Naga |
| `admin_barangay` | admin_level 10 boundaries |
| `place_label` | `place=city|town|village|suburb|neighbourhood` nodes |

## 4. Content schemas (defined in `packages/shared`)

```ts
Landmark {
  id: string;                    // "landmark/penafrancia-basilica"
  osm_id?: string;               // "osm:way/123456" — join key
  geometry?: GeoJSON;            // only if not in OSM (e.g. demolished)
  name: { en: string; fil?: string; bcl?: string };
  type: 'church' | 'school' | 'plaza' | 'market' | 'government' | 'bridge' | 'monument' | 'other';
  start_year?: number;
  end_year?: number;
  certainty: 'exact' | 'circa' | 'unknown';
  story?: { en: string; fil?: string; bcl?: string };  // markdown
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

Tour {
  id: string;
  title: LocalizedText;
  steps: {
    camera: { lat: number; lng: number; zoom: number; pitch: number; bearing: number };
    duration_ms: number;
    narration: LocalizedText;
    year?: number;
    select?: string;
    highlight?: string[];
    audio?: string;
  }[];
}
```

Validation rules:
- `sources` is non-empty for any record with a year or story.
- `end_year > start_year`.
- Photo `credit` and `license` are required.

## 5. Dating historical features — rules

- **Edit dates aren't build dates.** Never infer `start_year` from OSM edit history. OSM `start_date` tags may be used when present, with `certainty` derived from their format: `1954` → exact, `~1950` or `1950s` → circa.
- **Undated means always present.** Modern features without dates have no `start_year`. The UI legend explains that undated features show in all years.
- **Demolished features** go in content as standalone geometry. They are traced from old maps or imagery, with the tracing source recorded.
- **Old maps** are georeferenced in QGIS (Georeferencer) or Allmaps, exported as COG/XYZ, and listed in `content/historic-maps/*.json`, which records the year range covered, the source, and the permission.

## 6. Attribution (always visible in the UI)

"© OpenStreetMap contributors" is always shown. The other credits are added only when their layer is active:
- DEM: "Copernicus DEM"
- Satellite underlays: "Esri Wayback" or "Copernicus Sentinel-2"
- Each photo and historic map: its own credit, in the info panel

## 7. Research backlog (content team)

Record each item in content with its sources:

- Founding and key dates for the Basilica Minore, the Naga Metropolitan Cathedral, Plaza Quince Martires, Plaza Rizal, the Naga City Hall, the public market, and the major bridges over the Naga River.
- Street renamings in the Centro.
- The Peñafrancia Traslación and fluvial procession routes, including how they changed over time.
- Growth of the university belt.
- Major flood and typhoon events affecting the city.

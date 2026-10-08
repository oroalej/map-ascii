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
| Mapillary / KartaView | Street-level photos in the facts dialog | CC BY-SA | Link out or embed per their terms |
| Archival maps, photos, records (local libraries, universities, parish archives, private collections) | Historical layers, stories, then/now photos | Per item — record permission in content | Must have written permission for anything not public domain |

## 2. Pipeline (`pnpm data:build`)

All scripts live in `packages/data/scripts`. `pnpm data:build -- --city <slug>` builds one city. With no `--city`, it builds every city in the registry (every folder in `packages/content/cities/` with a valid `city.json`). Each step reads from the previous step's output in `packages/data/build/<city>/`, and each is idempotent.

1. **`01-fetch`**
   - Read `city.json`, then download OSM data for two bounding boxes:
     - **Detail bbox:** the city boundary plus the configured buffer (`detail_buffer_km`). The boundary relation is found via Overpass using the config's `boundary` lookup (name, admin_level, and parent area). Fail loudly if the lookup matches zero relations or more than one. The detail bbox is then clipped to the region bounds, because the camera can't leave the region. The search index likewise drops entries outside the region.
     - **Region bbox:** the configured `region`, fetched with low-detail filters only (coastline, major roads, railways, water, place nodes). A whole region is too much for one Overpass request, so each heavy layer is fetched per quarter of the region (cached separately) and the results are merged into `region.osm.json`. A bbox region can set `include_boundary: true` to union its rectangle with the whole city boundary. Detail queries then use four stable quarter caches, merged into `detail.osm.json`. For this opt-in, offline reuse requires saved response files and matching query filters with enough bbox coverage for every detail and regional query; retry without `--refresh` to reuse successful parts.
     - **Railways** (track and stations in the detail bbox) are a small query of their own, saved as `detail-rail.osm.json`, and the region's railway queries come after its other parts. Adding them left the big saved downloads valid, and the servers answer the small query when the big one times out. `overpass()` retries 429 and 5xx answers and dropped connections, rotating through the public instances (`OVERPASS_URL` pins one). A server that answers HTTP 500, can't be connected to, or serves data more than two days behind OSM is skipped for the rest of the run.
   - Download DEM tiles for the Region bbox.
   - Save raw downloads in `raw/<city>/` (gitignored) and keep them until `--refresh`: they never expire. A saved download is reused for the same query, or for the same query over a bbox inside the saved one (step 03 drops features wholly outside the region). `--offline` never downloads.
   - Transit stops, terminals, shelters, and covered entrances are fetched separately into `detail-life.osm.json`. Step 02 merges that optional download with the detail data; older cached downloads remain usable. Step 03 writes `life_site`, `life_modes` (bus 1, jeepney 2, tricycle 4), `life_covered`, and a stable `life_lng`/`life_lat` anchor. Rail and ferry platforms are excluded. Site metadata is retained from tile zoom 13 even while furniture glyphs stay hidden at smaller display zooms.
   - Waterfalls (`waterway=waterfall`, nodes/ways/relations and member geometry) use the separate bounded `detail-waterfalls.osm.json` cache. Step 02 admits it when present; older extracts without it remain convertible. A full offline fetch requires the saved supplemental response and matching query coverage, like the other supplements. Adding this filter leaves older detail downloads valid.
2. **`02-convert`**
   - Write `territory.geojson`: internal JSON metadata with the camera rectangle, retained territory (configured bbox union city polygon), and void (rectangle minus territory). Despite its prescribed filename, this is not a GeoJSON feature or collection. Without `include_boundary`, both geometries are null and existing rectangular behavior remains.
   - OSM → GeoJSON (`osmtogeojson`, or `ogr2ogr` / `osmium export` for PBF). The railway download is merged into the detail download first (if there is one).
   - DEM → hillshade/luminance raster (`gdaldem hillshade`) → grayscale PNG tiles.
3. **`03-normalize`**
   - Map OSM tags to atlas classes (see section 3).
   - Drop untagged or irrelevant features.
   - Compute building `height` (`height` tag, else `building:levels × 3`, else a class default) for features with `building=*` only. Grounds that share a building class (e.g. `amenity=school` on a campus polygon) get no height.
   - Assign stable ids: `osm:<type>/<id>`.
   - Compute `subdivision` using mapped boundaries at the city's `subdivision.admin_level`, then approximate Voronoi cells for city place nodes without mapped boundaries. With `include_boundary`, accept mapped relations only when their original uncut centroid is inside the city, intersect their HUD areas with the city, and retain original source rings for display outlines. Rejected relations contribute neither areas nor outlines. Complete roads and footprints remain intact for all derivation.
4. **`04-merge-content`**
   - Load and validate the city's pack (`packages/content/cities/<slug>/`) with zod, including checking that localized fields use only the city's declared languages.
   - Apply sourced `city.streets.exclusions` to exact OSM road ways before merging content or deriving traffic, utilities and site details. Each entry supplies `osm_id` and `source`; duplicate, missing detail-data and non-road/non-LineString targets fail the build. Remove matching region copies too. Saved OSM downloads and normalized inputs remain intact. Exclusions are display corrections, not historical demolition dates or edits to OSM.
   - Join curated records to features by `osm_id`, or add standalone features for demolished or historical things that OSM doesn't have.
   - Add the pack's curated `landcover/` (trees, tree rows, and grass, parking, woods, shrub, planting-bed or farmland areas that OSM doesn't map yet) as features of their class (`tree`; areas as `grass`, `parking`, `trees`, `shrubs`, `planting`, `farmland`) with ids `cover:<slug>/<tree|row|area>-<n>`, trees sized and kinded by the same rules as OSM trees. A curated tree with an OSM tree within 3 m is dropped with a warning to remove it from the pack; OSM areas of a curated area's class inside it are flagged.
   - Merge sourced `cemeteries/` burial rows onto existing `landuse=cemetery` or `amenity=grave_yard` areas. Retain grass, boundary geometry, drives, facilities and monuments; cemetery identity takes precedence over incidental park/garden tags. Explicit flush plaques, raised slabs and vaults use flat stone `building_part` polygons with stable `cemetery:<slug>/<row-id>-<n>` ids and the cemetery's name/selection. Add a matching curated landmark record with facts to enable pointer selection; its identity travels with each burial part for cold tile loads. Whole markers outside the boundary, in holes, on standing roofs/water, in full road/path widths or at tree/monument trunks are omitted. Reject missing/wrong/duplicate parents, overlapping rows and layouts with no surviving markers. Credits join map attribution. Positions and row counts may be draft estimates; never infer burial identities, dates or a surveyed grave inventory from a representative layout.
   - Write `start_year`, `end_year`, `certainty`, `name_history`, `landmark: true`, and `story_id` into properties.
   - Merge sourced outdoor `details/` (`SiteDetail`) onto an existing OSM area. Without curated grounds, `surface: "paving"` changes the area's ground class while retaining its id, labels, and landmark metadata. `surface: "keep"` retains its fill and tile range. A simple `grounds` ring must contain the complete standing building or point anchor and may not overlap another detail site; paving then adds separate unoutlined grounds without replacing the parent. Authored `walks` are simulation routes, not painted lines; `seating` becomes rounded, real-width `seating` footprints (closed lines make continuous planter edges) and sparse bench pause anchors on their accessible side. Optional `bench_spans` select named sections by inclusive start/end vertex indices and widen them to the specified `width_m`. Spans must have unique ids, non-overlapping ranges within the line (shared endpoints are allowed), and widths at least the base rim width. Omission seats the entire line as before; `[]` creates a rim without pause anchors. Rim and bench sections are unioned in a common meter frame into one footprint, preserving the planted hole and avoiding internal seams; anchors use only the bench sections and their widths; `lamps` becomes static multi-head hardware, with `style` defaulting to `streetlight`; `lantern` selects compact lantern clusters. Shrub polygons are blocked ground cover without tree trunks or bird roosts. Stable item ids survive record reordering. Reject missing/duplicate parents, building parents without grounds, out-of-bounds geometry, and routes across raised beds, monument parts or standing buildings (overhead roofs remain walkable); mapped benches and lamps within 3 m suppress curated duplicates. Optional `flagpoles` relocate existing OSM flagpole points by id, preserving their identity and refreshing label anchors and subdivision membership. Reject missing or non-flagpole targets, duplicate targets across detail packs, and positions outside the parent or inside raised obstacles. Omitted overrides default to an empty array. Optional `flag: "PH"` explicitly selects a Philippine flag marker at the mapped pole; omitted designs retain the generic pole glyph. The code is carried through tiles and worker fixture geometry, independent of Life. Credits join the generated meta attribution.
   - Give named landmarks and monuments a label anchor (`label_lng`, `label_lat`: a point's position or an area's centroid), computed before tiling so labels land in the same place in every tile.
   - Write minified `<city>.landmarks.json` and `<city>.tours.json` from the validated pack, and the existing placed `<city>.art.json` object (`{ pieces: [...] }`). The browser loads facts and tours on demand and art with the facts UI; they are no longer inline page props.
   - After a successful merge, save `detail-layouts.json` beside `merged.geojsonl`, binding the detail fingerprints to the city-pack inputs and merged bytes.
5. **`05-tiles`**
   - With `include_boundary`, subtract the void only from completed display features, before roof tile records. Preserve IDs, complete source roof plans and geometry beyond the camera rectangle; repair invalidated label/shop/Life anchors on surviving geometry. `merged.geojsonl` stays complete for search and generated layers. Admit utility supports after offsets and reject spans crossing the void; admit whole seasonal records including embedded geometry. Tours and explicit Life positions must lie in retained territory; step 07 validates emitted event geography against the void.
   - Validate and consume step 04's layout snapshot before compiling tiles. Starting with `--from 05` requires unchanged city-pack inputs and merged bytes; if either differs or the snapshot is missing, rerun from step 04.
   - Run tippecanoe (or Planetiler), with one layer per class group: `water, roads, buildings, landuse, poi, admin, labels, events`.
   - Exclude pipeline-only `highway`, `foot`, `access`, `vehicle`, `motor_vehicle`, `motorcar`, `motorcycle`, `hgv`, `bridge` and `event_path_width` properties from ordinary tiles. Explicit path widths inform event routing without changing legacy walking-line widths; ordinary road widths remain in the archive. For cities opting into utilities, read retained lamp supports from that base archive, bake the network from the complete merged features, tile a separate max-zoom `utilities` layer, and merge/audit it before copying the final archive.
   - Zoom ranges: Region layers z6–z11; detail layers z12–z16 (overzoom to z19 in the client).
   - Output `<city>.pmtiles` (via `pmtiles convert` if needed) and copy it to `apps/web/public/tiles/`.
   - Write `<city>.meta.json` (see `ARCHITECTURE.md` §2): bounds derived from the boundary, the default camera (the `focus` feature, else the boundary centroid), the region bounds, the subdivision label, languages, the year range from dated features, and attribution.
   - Write the separately validated `<city>.detail-layouts.json`, mapping detail ids to SHA-256 fingerprints of parsed geometry and selection fields. Only smoke tests load this asset; unchanged credits alone cannot establish tile freshness. Older pinned archives remain readable and unmatched local smoke cases skip. CI sets `ATLAS_REQUIRE_DETAILS=1`, requiring published fingerprints that match the current pack.
6. **`06-search-index`**
   - Build `<city>.search-index.json` from normalized features plus content, including alt names and name history.
7. **`07-processions`**
   - For `fluvial`, follow the rivers (`water_river`, in the direction OSM draws them, which is the way they flow) from the start down to the landing: the shortest river path from `route.from`, or `route.upstream_m` meters upstream of `route.to`, keeping to the river of the same name at confluences. Both ends must lie within 300 m of a river; the route ends at the river point nearest each (an end may be a landmark a short walk from the river). Optional `route.beyond_m` keeps that much river past `to` (onward away from the route, same-named river first, then the straightest way) for the boats ahead of the pagoda; `to` is then the landing, emitted as `landing_m`, and the riverside crowd stops there. Likewise `route.before_m` keeps river behind `from` (away from the route) for the boats following the pagoda; `from` is then the departure, emitted as `departure_m`, and the riverside crowd and its bridges include that stretch.
   - Resample the route to points at most 10 m apart and measure, at each, how far the water reaches to its left and right (`banks`, from the `water_area` polygons; left out where the river is mapped only as a line).
   - For `procession` and `parade`, route along connected eligible roads and paths, optionally restricted to `via` way IDs. Ordered `through` stops (feature ids snapped like endpoints) split the route into legs, each the shortest path to the next stop, so a loop keeps its authored order; edges are emitted in traversal order. Snap endpoints within 200 m, exclude steps and prohibited access, and require enough explicit/conservative width for the selected formation and vehicles. Vehicle-bearing parades check generic and vehicle access independently of pedestrian exemptions. Paths have no additional sidewalk allowance. Emit samples at most 10 m apart with aligned source identities, widths and route-relative `sidewalks_m: { left, right }`; reverse the source sides when routing backwards. Unmapped or absent sides have zero width. Legacy symmetric `sidewalk_m` remains readable; new output sets it to the smaller side. Mass approach paths also need measured widths. Seasonal bunting shares this graph without changing its ordering.
   - Validate complete formation clearance before routing. Unsafe portions reroute or fail; a connected endpoint snap may be at most 50 m farther from its anchor than the nearest safe road position, with an overall 200 m ceiling. Clip roof/barrier exclusions and water to the event corridor, keeping only the part inside it. A standing-building sliver smaller than 0.1 m² inside the clearance band (a misregistered footprint corner grazing the carriageway) does not cut a street. Tagged bridge decks and at most 25 m of directly connected approaches authorize only their carriageway footprint over water; nearby roofs and off-bridge water remain excluded. Runtime permissions and exclusions use spatial indexes, and agents transport only their route ID. New ground-event coordinates are rounded to six decimals; legacy fluvial data and physical dimensions retain their precision. The generated processions gzip budget is 60 KB.
   - For `mass`, resolve the church and authored grounds from complete merged geography. Bake connected outdoor gathering cells and approaches within the overflow radius, excluding roofs, water and barriers by full-cell polygon intersection. Optional pack `gathering_anchor` selects an exterior forecourt; fail if it cannot snap within one 2 m cell to safe connected ground. Without it, select a safe outdoor anchor. Clip obstacle and ground-hole exclusions to the site square, retaining water rejection inside it. The generated Mass has a `site`, without a route or length.
   - New street output includes proven `clear_m` and derived `verge_m` (up to 6 m per side), while sidewalks remain tag-only. Safe 2 m lattices retain every component of authored crowd areas and Mass boundaries, subtracting complete hard geometry. A street event's optional `crowd_exclude` areas (OSM area ids, such as private grounds beside the route) are clipped to its verge and crowd-area corridor and added to `blocked`; an exclusion that reaches the route carriageway fails the build. Mass output distinguishes audience, selected outdoor seating, altar placement/permission and the full traffic closure zone (an optional `traffic_closure` ring, else the crowd boundary; it removes moving and parked cars for the whole Mass); connected approaches remain a separate walker policy. Fluvial crowd ground is the river sides, a band from the water's edge to 8 m inland on each bank, plus the decks of walkable bridges whose line crosses the boat route (also their permission over water). Optional `crowd_focus` entries (`near` an OSM feature, `radius_m`, `reach_m` up to 40 m) widen the band inland around that feature. Optional owner-marked `crowd_rings` add crowd ground beyond the banks (a landing, the roads to a church) and ship as the crowd ground's `closure_zone`, which closes them to moving and parked cars while the event plays. A bank sample that found no water edge within 60 m (where the route turns into the shore at a landing) takes its nearest measured neighbour's banks for the crowd. Other water stays blocked. Quantize every new geographic field to six decimals without changing legacy river samples, banks or physical measurements.
   - The shared step-05 `writeMetadata` path updates geography/year ranges and all four credit categories without invoking tippecanoe or rewriting tiles.
   - Resolve `follows` dependencies by ID, independent of file order, carrying predecessor duration across midnight into the annual offset. Generated schedules are explicit and retain predecessor IDs for crowd handover. Missing references and cycles fail validation.
   - Write `<city>.processions.json` (the `CityProcessions` schema), published with the tiles. Cities without processions get no file.

8. **`08-emergency`**
   - Skip packs without `life.emergency`. Build the main strongly connected directed component of major/mid/minor roads, respecting one-way transitions, then contract compatible degree-two source chains.
   - For packs opting into the whole boundary, subtract the territory's void before selecting the road component and station targets, using the same late display geometry as tiles. Full source geography remains available to earlier derivation steps; flagless packs keep their existing network.
   - Snap hospital and station centroids within 120 m against complete source polylines. Keep source road identity, cumulative interior progress, canonical tangent and signed side; thin building targets to one per 100 m cell within 30 m of a road.
   - Fail for missing configured targets. Write validated `<city>.emergency.json` with delta/varint geometry and a 32 KiB gzip cap. Re-running `--from 08` uses current merged intermediates and changes only this file.
   - When an opted-in expanded territory exceeds that cap, keep every service target and select building destinations across the city. Retain shortest directed paths in both directions between those destinations and each service location, plus shortest hospital routes from retained road endpoints. Use the decoded codec's rounded costs, preserve one-way permissions and complete admitted edge shapes, and omit roads that none of these routes use. Packs without the boundary flag retain their existing graph policy.

Required CLI tools: `tippecanoe`, `gdal`, and optionally `osmium-tool` and the `pmtiles` CLI. Document the install steps in `packages/data/README.md`. Consider a Dockerfile so the pipeline is reproducible.

## 3. Class mapping (starter)

| Atlas class | OSM tags |
|---|---|
| `water_river` | `waterway=river` (from the City level) |
| `water_stream` | `waterway=stream|canal` (from the District level) |
| `water_stream` / `water_area` | `waterway=waterfall`: points and crest lines use ordinary stream water, area footprints use area water; retain the OSM identity and `kind` for sourced landmark facts/detail |
| `water_area` | `natural=water`, `water=*`, `waterway=riverbank`; `natural=coastline` (processed into sea polygons, with the Region layers in Phase 2) |
| `road_major` | `highway=motorway|trunk|primary` (+ `_link`) |
| `road_mid` | `highway=secondary|tertiary` (+ `_link`) |
| `road_minor` | `highway=residential|unclassified|service|living_street` |
| `path` | `highway=footway|path|pedestrian|steps|track` |
| `rail` | `railway=rail|narrow_gauge|light_rail`, sidings and yards included (disused and abandoned track isn't fetched); `service=siding|spur|yard` goes in `variant` (trains stand by there) |
| `building` | `building=*` |
| `building_religious` | `building=church|cathedral|chapel` or `amenity=place_of_worship`; `landuse=religious` grounds (no height) |
| `building_school` | `amenity=school|university|college` (area or building) |
| `building_hospital` | `building=hospital`, `amenity=hospital`, or `healthcare=hospital` (area or point; grounds have no height) |
| `building_market` | `amenity=marketplace`, `shop=mall|supermarket` |
| `building_station` | `building=train_station`, `railway=station|halt`, or `public_transport=station` with `train=yes` or a `railway` tag (area or point) |
| `park` | `leisure=park|garden|playground`, `place=square` |
| `paving` | a sourced `details/` ground-surface override or curated grounds around an existing OSM anchor |
| `seating` | sourced real-width stone seating and planter edges from `details/` |
| `shrubs` | curated shrub polygons from `landcover/` |
| `planting` | curated soil and sparse ground cover in planting beds; `raised` beds block ground agents |
| `trees` | `natural=wood`, `landuse=forest|orchard` (kind in `variant`, including mapped palm orchards) |
| `grass` | `landuse=grass|meadow|village_green|plant_nursery|cemetery`, `amenity=grave_yard`, `natural=grassland|scrub|heath`, `leisure=recreation_ground` or `landuse=recreation_ground` (a park wins on recreation grounds; cemetery identity wins on burial lawns) |
| `farmland` | `landuse=farmland|paddy` / `crop=rice` |
| `monument` | `historic=monument|memorial`, `memorial=statue|bust`, `tourism=artwork` |
| `building_part` | not from OSM tags: plan-view landmark parts from `plans/`, and flat stone burial geometry from `cemeteries/` (pipeline step 04) |
| `tree` | `natural=tree` (points), `natural=tree_row` (lines) (kind in `variant`; `height` and `crown`); also the city pack's curated `landcover/` trees and rows (pipeline step 04); its areas are `grass`, `parking`, `trees`, `shrubs`, or `planting` |
| `barrier` | `barrier=fence|wall|hedge|gate` (kind in `variant`) |
| `entrance` | `entrance=*` |
| `furniture` | `amenity=bench|fountain|shelter|bus_station`, `highway=bus_stop|street_lamp`, road transport platforms, sourced tricycle ranks, `man_made=flagpole`; standalone food/retail/service shops (kind in `variant`; shelters with buildings keep their building class) |
| `parking` | `amenity=parking` |
| `pitch` | `leisure=pitch` |

Roads also carry `width` (meters: the `width` tag, else `lanes` × 3.2, else 14 / 10 / 6 m for major / mid / minor), and buildings with `roof:shape` carry it as `variant`. Trees and woods carry their kind as `variant`: `palm` when `genus`, `species`, `species:en`, or `taxon` names a palm (OSM's `leaf_type` has no palm value), else `leaf_type` (`needleleaved` or `broadleaved`). Trees also carry `height` and `crown` (crown diameter) in meters: the `height` and `diameter_crown` tags, else a typical size for the kind (10 / 8 m, palms 12 / 6 m, needleleaved 12 / 5 m).
| `admin_city` | the city's boundary relation (from `city.json`; admin_level 6 for Naga) |
| `admin_subdivision` | boundaries at the city's `subdivision.admin_level` (10 for Naga's barangays) |
| `place_label` | named `place=city|town|village|suburb|quarter|neighbourhood` nodes |

### Street enrichment

`streets.utilities?: { derive: boolean; source: string }` opts a city into illustrative overhead utilities; omission disables them and `source` must be nonempty. Step 03 retains the original `highway` tag separately from display `kind`. Step 05 uses complete local motorway/trunk/primary/secondary ways and their links, excluding regional, tertiary and smaller streets. It canonicalizes direction and multipart order, places seeded 30 m slots with ±6 m jitter, rejects blocked footprints, water and other carriageways/medians, and bakes corridor, explicit crossing and topologically connected junction spans. A 67% sharing *attempt* can reuse only a retained same-road/same-side lamp within the slot window; it is not a promised shared-pole percentage. Site lanterns and junction lamps are excluded. Placement covers the union of city and configured map-region bounds, so local streets visible outside the city bounding box retain utilities. Safe supplemental supports repair short way fragments, junction approaches and long rejected-slot gaps; they may use the opposite verge while keeping the same obstacle checks. Junctions connect all supported branches with a deterministic minimum spanning tree, including interior source vertices. A source connector up to 35 m long with no safe support can carry topology between its endpoint junctions. Nearby roads without shared source topology are never joined. Supports used at junctions must be within 65 m along their source component; every span is at most 65 m. Remaining unsafe gaps and unresolved joins are reported under `continuity` in `utilities-report.json`.

Utilities are generated separately at archive max zoom, with precise endpoint payloads in a versioned `utility` JSON property, then merged using [`tile-join`](https://github.com/felt/tippecanoe#tile-join) without feature or tile-size dropping. The pipeline restores the base PMTiles v3 header extent/center after the merge and audits unchanged ordinary geometry/order, unique identities, complete survival and matching span endpoints. `utilities-report.json` and `utilities-manifest.json` in the city's build directory record the result. The original `highway` stays in normalized/merged intermediates for generation; ordinary tiling excludes it for every city, while display `kind` remains available for labels. No new geographic source or surveyed/historical utility claim is introduced. To regenerate after changing this policy or placement, use `pnpm data:build -- --city <slug> --offline --from 03`, then publish and pin the generated assets as described in §9.

Road normalization reads `sidewalk`, `sidewalk:both`, `sidewalk:left`, and `sidewalk:right`. Side-specific tags override `sidewalk:both`, which overrides the general tag; `no`, `none`, and `separate` suppress the band on that side. Widths use `sidewalk:width`, then `sidewalk:both:width`, with side-specific widths overriding each side independently; the fallback is 2 m. Tiles retain `sidewalk`, `sidewalk_width`, `sidewalk_left_width`, `sidewalk_right_width`, and `sidewalk_src: "mapped"`. Left/right follow the original OSM way direction; in downward-positive tile coordinates the left normal is `(dy, -dx)`.

Step 04 may add both sidewalks to untagged, non-region `road_major` and `road_mid` features at 2 m per side, with `sidewalk_src: "derived"`. `city.streets.sidewalks.derive` defaults to true; an explicit sidewalk policy requires a nonempty `source`. A false policy keeps mapped bands only. The legend receives this policy from the city pack. Logs report sidewalk-side kilometers separately from the road kilometers they cover. Naga explicitly disables derivation pending a sourced survey.

`oneway=yes|true|1` becomes 1, `oneway=-1|reverse` becomes -1, and `no|reversible|alternating` becomes 0. Without an explicit `oneway`, `junction=roundabout|circular` implies 1; other roads default to 0. Step 04 applies sourced `city.streets.directions` overrides before resolving traffic approaches and markings. Each entry identifies an `osm:way/<id>` and supplies `oneway: -1 | 0 | 1`, relative to its unchanged OSM coordinate order; zero removes the restriction. Duplicate targets, missing detail ways, and non-road/non-LineString targets fail the build. Region copies stay unchanged. Corrected roads retain `oneway_source`, also used in their arrow provenance.

Nonzero direction is retained in tiles and carried on life polylines. Simulated road vehicles, including bicycles, spawn along that flow, use the full usable road width for same-direction lanes and exclude exits entered against it; boats, walkers and trains ignore it. One-way vehicles with no legal exit brake and hold before the endpoint with front-bumper clearance, including at clipped endpoints. Placement retries and collision retries also cannot reverse their flow. Two-way roads retain their dead-end turnaround. Arrow anchors are baked from complete original segments before tippecanoe clips them. Their world-meter phase gives 30 m spacing, with an 8 m exclusion at real segment vertices; tile seams do not restart the phase or add exclusions. The worker draws each anchor as an exact 3 m by at most 3 m quad.

The small traffic query also fetches `highway=stop` nodes. Resolved signals generate stop lines on inbound approaches only, at the greater of `signal_radius + 1.5 m` and the selected crosswalk band's far edge plus 1.5 m, accumulated along the whole owned approach polyline. Outgoing-only arms have no stop. A short first segment can continue through bends; only a whole path ending before the required band/stop fit is omitted and reported. Two-way lines cover half the road, centered one quarter-width to the right of travel; one-way lines cover the full road. Driving side currently defaults to right: the city schema has no driving-side setting. Mapped stop nodes must match a road vertex. A `direction=forward|backward` sign resolves one approach; at an ambiguous shared vertex the lowest road rank, then narrower width and stable id resolve the tie. An undirected junction sign covers approaches of the lowest-ranked road; undirected mid-block nodes are skipped and counted. Coincident lines are deduplicated, preferring mapped provenance. Stop anchors carry `stop_bearing`, `stop_width`, `stop_road`, and `stop_src`; they produce an exact 0.5 m long quad and never a point glyph. Positions, line dimensions and arrow spacing are illustrative rather than surveyed road paint.

## 4. Content schemas (defined in `packages/shared`)

Optional `life.emergency` supplies per-kind `max` (0–3) and `[min,max]` simulated-second intervals. Ambulance/fire include `dwell_s`; police include `call_every_s` and `call_s`. At least one kind and a `source` are required. `exclude` lists station OSM identities to omit. These are illustrative settings, without dispatch or construction-history claims. Step 08 validates the generated `CityEmergency` payload and its graph/target references; the browser uses the corresponding plain codec guard.

Optional `life.folklore` enables illustrative nighttime ghosts and a seasonal manananggal. `hours.from` and `hours.to` are city-local integer minutes (0–1439), must differ, and may wrap midnight. `ghosts.sites` is a nonempty, unique selection of `cemetery`, `worship`, and `hospital`; `per_cemetery` and `undas_per_cemetery` are ascending integer `[min,max]` counts (1–16). `site_share` and `manananggal.night_chance` are probabilities (0–1). `range_m` is an ascending positive `[min,max]` range in metres, at most 200. `undas_season` must name a season in the same pack's `life.seasons`; `manananggal.window` uses the annual season-window schema. Nonempty `sources` are required and describe folklore and illustrative settings, without claims about individual sites. Field/roof sidecars come from existing mapped geometry at runtime; this block requires no new tile archive or geographic edits.

```ts
City {                           // cities/<slug>/city.json
  slug: string;                  // "naga", also the route and file prefix
  name: LocalizedText;
  country: string;               // ISO 3166-1 alpha-2, e.g. "PH"
  boundary: { name: string; admin_level: number; within?: string };  // Overpass lookup
  detail_buffer_km: number;
  region: { name: string; osm_relation?: string } | { bbox: [number, number, number, number]; include_boundary?: true };
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
    crops?: { rice?: {
      source: string; notes?: string;
      calendar: { from: string; stage: 'fallow' | 'flooded' | 'transplanted' | 'growing' | 'ripe' | 'harvested' }[];
    } }; // canonical real MM-DD, unique starts, at least two; February 29 skipped outside leap years
  };
  // The city's IANA time zone, e.g. "Asia/Manila": the life layer's clock, fixed times of day,
  // and seasons follow it. Without it: the sun's time at the city's longitude.
  timezone?: string;
  // Street enrichment. An explicit sidewalk policy requires its decision/survey source.
  streets?: {
    utilities?: { derive: boolean; source: string }; // omission disables utilities
    sidewalks?: { derive?: boolean; source: string }; // derive defaults to true
    directions?: { osm_id: string; oneway: -1 | 0 | 1; source: string }[];
    exclusions?: { osm_id: string; source: string }[]; // sourced display corrections
  };
  // The daily rhythm (SPEC.md §4 "Time of day"): per kind (vehicle, person, boat, train), how
  // much is out over the local day, as [hour 0–24, share 0–1] points, hours ascending, read
  // straight between points and across midnight. A kind left out uses DEFAULT_RHYTHM.
  life?: {
    emergency?: EmergencyConfig; // optional illustrative vehicles and OSM station exclusions
    folklore?: FolkloreConfig; // optional sourced ghosts and seasonal manananggal
    // Annual illustrative decorations; source calendars and placement estimates.
    seasons?: Season[];
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
  facts?: LandmarkFact[];        // 3–5 sourced facts; presence enables pointer hover/click
  story?: LocalizedText;         // markdown
  photos?: { src: string; year?: number; caption?: string; credit: string; license: string }[];
  sources: { title: string; url?: string; note?: string }[];   // required, min 1
}

LandmarkFact {
  text: LocalizedText;            // English ≤240 characters; declared city languages only
  year?: number;                 // integer Year when dated
  certainty?: 'exact' | 'circa'; // only with year; unknown is invalid for facts
  source: number;                // nonnegative integer index into Landmark.sources
}

```

Every fact source index must be less than the landmark’s sources length. Invalid references identify the fact index and `facts[index].source`. Facts may be undated without certainty, or dated with certainty omitted, exact or circa. These constraints are separate from landmark-level certainty, which still permits unknown. Fact dates do not establish a construction date for the current mapped footprint.

```ts
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
  season?: string;               // city life season ID; requires label.en
  label?: LocalizedText;         // short menu title
  kind: 'fluvial' | 'procession' | 'parade' | 'mass';
  // fluvial only: exactly one of from / upstream_m
  route?: { to: string; from?: string; upstream_m?: number; before_m?: number; beyond_m?: number }
        | { from: string; to: string; via?: string[]; through?: string[] }; // street kinds: OSM way pins, ordered stops
  site?: string; grounds?: string[]; radius_m?: number; // mass only, no route
  gathering_anchor?: [number, number]; // mass: authored exterior point; snap to connected safe ground within 2 m
  schedule: {                    // offset_days after the nth weekday (0 = Sunday) of month
    month: number; weekday: number; nth: number; offset_days: number;
    start: string;               // "HH:MM", local
    duration_min: number;
    timezone: string;            // IANA, e.g. "Asia/Manila"
  } | { follows: string; duration_min: number };
  formation?: { columns?: number; ranks?: number; escorts?: number } // fluvial
            | { bearers?: number; ranks?: number; marshals?: number } // procession
            | { contingents?: number; ranks?: number; band?: number;
                color_guard?: number; vehicles?: ('car' | 'truck' | 'motorcycle')[] }; // parade
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
  tree_overrides?: { osm_id: string; kind?: TreeKind; crown_m?: number; height_m?: number }[]; // appearance only; mapped tree point required
  rows?: { line: [lng, lat][]; kind?: TreeKind; crown_m?: number; height_m?: number }[];
  areas?: { ring: [lng, lat][]; cover: 'grass' | 'parking' | 'woods' | 'shrubs' | 'planting' | 'farmland'; kind?: TreeKind; raised?: boolean }[];  // closed ring; kind: woods only
  status: 'draft' | 'verified';  // draft until checked on the ground or against newer imagery
  credit: string;                // shown with the map attribution, e.g. the traced imagery
  sources: Source[];
}
TreeKind = 'broadleaved' | 'palm' | 'needleleaved';   // unset: the generic tree

Cemetery {                      // cities/<slug>/cemeteries/*.json — sourced burial layouts
  id: string;                    // "cemetery/<slug>"
  osm_id: string; title: string; // existing mapped cemetery area; explicit cemetery label
  rows: {
    id: string;                  // stable unique key
    line: [[lng, lat], [lng, lat]]; // distinct first/last marker centres; singleton uses midpoint
    count: number;               // 1–200 representative markers, not an inventory
    kind: 'flush' | 'slab' | 'vault';
    width_m: number; length_m: number; height_m: number;
  }[];                           // 1–500 rows, at most 15,000 markers per pack
  status: 'draft' | 'verified';
  credit: string; sources: Source[];
}
// Width runs along the row; length is perpendicular. Flush height must be zero;
// slabs/vaults must be raised. Small heights retain the renderer's existing metre quantization.

SiteDetail {                     // cities/<slug>/details/*.json — sourced outdoor detail
  id: string;                    // "detail/<slug>"
  osm_id: string; title: string; surface: 'paving' | 'keep';
  grounds?: [lng, lat][];         // simple closed ring containing the complete area, point or line parent
  extent?: [lng, lat][];          // alternatively, confine detail wholly inside an area parent
  selection_osm_id?: string;      // optional canonical curated landmark for these grounds
  structures?: {
    id: string; ring: [lng, lat][]; height_m: number;
    holes?: [lng, lat][][];       // simple non-overlapping open interiors inside the outer ring
    material: 'wood' | 'stone' | 'roof' | 'paving' | 'pitch' | 'water'; overhead: boolean;
    roof_shape?: 'flat' | 'gabled' | 'hipped' | 'pyramidal';
    roof_osm_id?: string;         // both roof fields required for an explicit overhead roof wing
    ground_override?: boolean; // paving only; omitted/false retains ordinary terrace priority
  }[]; // default []; simple closed footprints wholly inside the parent area
  roof_overrides?: { osm_id: string; shape: 'flat' | 'gabled' | 'hipped' | 'pyramidal' }[]; // standing mapped buildings inside the site
  building_overrides?: { osm_id: string; height_m: number }[]; // sourced height, same standing footprint/id
  parked_vehicles?: { id: string; at: [lng, lat]; bearing: number; kind: 'car' | 'bus' }[]; // at most 200 fixed illustrative vehicles
  flagpoles?: { osm_id: string; at: [lng, lat]; flag?: 'PH' }[]; // existing mapped flagpoles; defaults to []
  walks: { id: string; line: [lng, lat][]; width_m: number }[];
  seating: {
    id: string; line: [lng, lat][]; width_m: number; height_m: number;
    facing: 'left' | 'right';
    bench_spans?: { id: string; start: number; end: number; width_m: number }[];
  }[];
  lamps: { id: string; at: [lng, lat]; bearing: number; reach_m: number; heads: number; style?: 'streetlight' | 'lantern' }[]; // default: streetlight
  status: 'draft' | 'verified'; credit: string; sources: Source[];
}
// CuratedArea also accepts raised?: boolean for planting beds ground agents cannot enter.

`extent` and `grounds` are mutually exclusive. An extent preserves the complete source parent and canonical selection while limiting additions to a contained part of it. Explicit extents and grounds must not overlap other detail sites. Fixed `parked_vehicles` emit neutral plan-view body, glazing, roof and wheel silhouettes through existing geometry classes, visible with Life off. They create blocked footprints, not simulated traffic or new building/activity identities. Whole parts must clear site edges, mapped roofs/water/carriageways/paths and authored roofs; inventories cannot overlap. Dimensions are illustrative (4.4 × 1.8 m cars; 10 × 2.5 m buses), and the pack's draft status and credit apply. Vehicle/extent changes invalidate the detail layout fingerprint; omitted/empty parking retains legacy fingerprints.

`selection_osm_id` resolves kept grounds and paving terraces to an existing curated landmark. It must overlap the site or have a facade within 5 m of its boundary (OSM grounds can stop at an approximate building frontage); remote targets and alias chains are rejected. Structures on kept or explicitly outlined grounds also select that site's canonical landmark, including a canopy above an OSM lawn. A bounded `detail_selection` descriptor carries canonical id, class, name and landmark metadata through tiles, so selection works before the target's own tile loads. It creates no geometry or additional picking ink. Malformed or mismatched descriptors are ignored by the worker.

Structure parts receive stable `detail:<slug>/structure-<id>` identities. Timber uses
`building_woodwork` (from z18); stone and roof contours use `building_part`. Parts are flat
plan-view polygons with height shading and outlines, beneath taller crowns. Elevated beams
and roof contours carry `detail_overhead: true`: their visible coverage hides ground figures,
but they create no ground obstacles. Supports and platforms are blocked footprints. Walking
routes and bench anchors must clear these ground parts; an overhead part may span a route.
The merge rejects structures crossing the plaza edge, a concavity, or a hole, even if all
their vertices lie inside. Existing detail records need no changes.

Structures may have open interiors: the merge rejects holes outside the outer footprint,
overlapping holes and empty surfaces. Tile triangulation retains the holes, so a running
track leaves its lawn infield open without seams between radial pieces. `material: 'water'`
adds a sourced water footprint using the existing water renderer and canonical
site selection. Water anchored to a mapped water feature retains its natural `kind` (or `natural=water` when absent); other sites retain the existing `leisure=swimming_pool` default. Water parts block pedestrian routes and reject standing-roof and mapped-water
overlap. Author surrounding decks with an open water interior. No new renderer
class or timeline date is introduced. `material: 'pitch'`
emits a walkable sports pitch with canonical site selection and rejects overhead placement
or intersections with standing buildings. Thin paving strips can represent painted court
markings without introducing blocked stonework.

An explicit roof wing requires `material: 'roof'`, `overhead: true`, `roof_shape` and
`roof_osm_id`. Its entire shape must fit above the standing mapped building at a greater
height; it uses ordinary building roof shading and the source site's canonical selection.
Roof pieces create no additional school/market activity anchors.
Optional `roof_overrides` replace a building's generic inferred shape, commonly flattening
the base under separately traced roof wings, while preserving its footprint and height.
Optional `building_overrides` correct sourced heights (positive and at most 255 metres)
without changing mapped footprints or identities. Targets must be standing buildings fully
inside the site; duplicate, missing and exterior targets fail the build. Omitted/empty
overrides preserve older layout fingerprints; height changes invalidate them. Storey-based
estimates must document floor height and uncertain wing assignment in the pack's sources.
Missing, non-building, exterior and duplicate targets fail. These visual estimates do not
establish construction history or cadastral ownership.

An existing OSM `LineString`, such as a bridge centreline, can anchor a detail pack only
with explicit `grounds`. The outline must contain every complete segment, including
intermediate vertices and segments crossing concave boundaries; endpoint containment
alone is insufficient. The original road geometry, width, class and identity remain.
Use `surface: 'keep'` for riverbank structures so the coverage envelope adds no ground
fill across water or bridge traffic.

Landcover `tree_overrides` refine a mapped tree's crown, height or kind before curated-tree
deduplication. They never move the trunk or create another feature. At least one attribute
is required; missing, non-tree and duplicate targets fail. A crown can overhang a nearby
road or roof; that does not relocate the mapped trunk or establish an exact species.

`material: 'paving'` supplies a walkable raised surface or stair tread, requires
`overhead: false`, and creates no ground obstacle. It emits the `paving` class with
`variant: 'terrace'`, retaining fractional `height` values and a `detail_parent` selection
identity. Its connected outlines show from z18. Adjacent treads use non-overlapping
  footprints so their boundaries remain distinct even at equal quantized heights.

  Optional `ground_override: true` emits `variant: 'terrace_override'`. Use it for sourced
  paving replacing a coarse grass, park, parking or other ground fill. It draws above those
  fills and campus grounds, below planting, shrubs, benches, water, standing buildings,
  paths and roads. The CPU and GPU partial-cell rules preserve that order at edges. The
  merge rejects an override intersecting a standing footprint, even when the obstacle is
  wholly enclosed by the court. Content guards also check full-width carriageway clearance.
  Ordinary terraces and existing plaza packs retain their previous draw behavior.

LandmarkArt {                    // cities/<slug>/art/*.json — front views in the facts dialog’s Drawing disclosure
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
- A land cover file has at least one tree, row, or area, a `credit`, and `sources` naming what it was traced from. Positions come from a credited imagery reference (owner-supplied screenshots included), and each file retires as OSM maps what it holds (pipeline step 04 warns). Prefer separate trees to a woods area where crowns are distinguishable: at close zoom a woods area draws as one continuous canopy.

`Season` records have a unique lowercase kebab-case `id` (`auto` is reserved), localized `title`, `window`, optional `includes`, at least one decoration or emoji group and nonempty `sources`. Extra title languages must be declared by the city. The strict schema rejects unknown fields and impossible month/day pairs. `includes` is a nonempty list of unique season ids from the same pack; self-references and included seasons with their own includes are rejected. The composed installation list, including the season’s own list and every included list, must have unique ids and at most 32 entries. Unrelated seasons may reuse installation ids. At runtime, own lantern, bunting, stall and firework groups take precedence; missing groups use the first included value. Installations append after the season’s own list, in include order. Expansion happens once in shared code, while generated records keep their original season id. Including existing decorations alone requires no tile rebuild. Source notes continue to describe uncertain calendars and illustrative placement.

Optional memorial groups are `candles: {label, share}`, `visitors: {label, share, per_grave_family, max_per_tile, hours}` and `congregations: {label, landmarks, extra, hours}`. Shares are in (0,1]; families contain 1–8 people with ordered bounds, visitors are capped at 1–150 per tile, and each selected church adds 1–100 candidates within the combined gatherer cap. Hours are increasing daily RhythmCurve breakpoints below hour 24. Congregations list 1–16 unique curated `landmark/<slug>` identities, cross-checked against the pack. These groups participate in runtime serialization and first-included-group composition with own values taking precedence. Seasonal `near` accepts cemetery anchors without changing ordinary place kinds; cemetery radius extends proximity reach. Candles and visitors use owned burial centres from maximum-zoom tiles and bounded, safe illustrative sites in markerless mapped cemetery fragments. Parent stand-ins cannot establish missing markers. No archive rebuild is required. Source notes identify the scope of evidence and unsurveyed placement, counts, hours and church selection.

Windows are inclusive: `{ from: {month, day}, to: {month, day} }` wraps when the end precedes the start; or `{ anchor: {month, weekday, nth, offset_days}, days_before, days_after }`, with weekdays 0–6, nth 1–5, offset ±31 and margins 0–60 days. A missing leap-day endpoint or fifth weekday skips that occurrence. Matching checks adjacent years, including January anchors whose lead-in begins in December. This does not change historical date tagging or procession scheduling.

Seasonal moods live in `life.seasons[].emoji`. Each strict entry has `mood`, a nonempty duplicate-free `subjects` list and `weight` (positive, at most five; default one), plus optional `[from,to)` integer-minute `hours`, one to four duplicate-free real month/day `days`, and `figure: "adult" | "child"` only for person-only entries. Hours may wrap midnight; 1440 denotes the day's end, and equal endpoints are invalid. Drinking (`cheers`, `beer`) requires person-only adults and an entirely evening window beginning at or after 16:00, with a wrapped end no later than 06:00. Authored days must belong to the season's own annual window; inherited entries retain their originating restrictions. A season may contain emoji alone. Own entries precede one-level included entries, with a composed maximum of 20. Emoji needs no tile rebuild.

Before 06:00, special-night matching uses the previous city epoch day through UTC calendar arithmetic. A valid explicit season preview different from the real-date active season ignores entry days at half weight, retaining subject, figure and hour restrictions. Unknown IDs falling back to Today do not count as previews. Source notes must describe these moods as illustrative simulated expression, never observations of residents.

Decoration groups: `lanterns: {label, shape: 'star', near?, radius_m?}` (optional near/radius supplied together, radius 50–3000 m); `bunting: {label, near, radius_m, spacing_m, corridors?}` (radius 50–1000 m, ordinary spacing 15–80 m); `stalls: {label, near, radius_m, per_tile}` (radius 50–600 m, cap 1–24). `near` is a nonempty unique list of seasonal anchor kinds: the existing place kinds plus `cemetery`. Stall eligibility also includes mapped markets unless `near` lists only `cemetery`. Ordinary positions are generated at runtime from loaded geometry; adding a calendar without corridors requires no tile rebuild or schema-version change. Calendar sources do not establish surveyed decoration positions.

`fireworks: {label, variants}` is also a decoration group and can be the only group in a season. `variants` is a nonempty unique subset of `peony`, `chrysanthemum`, `ring` and `willow`. Launch sites are derived in the browser from existing residential map geometry, including conservative neighborhood inference. Adding fireworks requires no geographic tile rebuild; these illustrative sites do not establish verified household occupancy or an actual fireworks event.

Each optional corridor is `{id, ways, from?, to?, spacing_m, style: 'red-yellow-rectangles'}`. A season accepts 1–32 unique kebab-case corridor ids, each with 1–100 unique `osm:way/<id>` references and 3–80 m row spacing. Endpoint references accept OSM nodes, ways or relations. Step 05 requires every road and endpoint in complete non-region source geometry; missing roads, disconnected graphs, excessive rows or endpoints farther than 200 m from the selected road fail the build. Endpoint centroids project onto the road and trim the selected route. One endpoint requires a linear road graph; two endpoints select their shortest connected path. With neither endpoint, all selected segments, including terminal branches, receive rows. Distances carry across road fragments rather than restarting at tile or way boundaries. Naga's requested Fiesta profile uses 3 m, following the owner's request to halve the original 6 m gap. These are generated candidate rows; runtime junction admission can reject an entire conflicting row. Tiles carry one `bunting-run` record per corridor edge (oriented segment, first-row offset, spacing, row count, reach and seed); decoding expands it into version-1 `bunting` rows with per-row identities and seeds, so a dense corridor costs one record per edge rather than one per row. Where branches leave one node, only the first edge hangs the node's row. Repacking projects only the admitted rows that can reach the view.

Corridors require a tile rebuild (`pnpm data:build -- --city <slug> --offline --from 05` when earlier outputs exist). They add an optional `seasons` MVT layer at the archive's maximum zoom, with strict version-1 records in the `seasonal` JSON property. Exact span endpoints and the trimmed source segment survive buffered tile clipping; identities deduplicate repeated records. The pipeline audits every existing tile/layer and header bounds against the base archive, and requires all generated rows to survive. Counts and archive sizes are written to `build/<city>/seasons-report.json`. The browser ignores malformed/future optional records, and older archives retain ordinary seasonal decorations. Publish rebuilt tiles and update their lock only when authorized; local web builds preserve rebuilt files that differ from the pinned release.

`Season.installations` optionally adds up to 32 unique sourced definitions. Each has `id`, `anchor` (an OSM feature id), `label`, `sources` and one kind: `christmas-tree` with a 1–12 m `radius_m`; `light-string` with `layout: 'paths' | 'perimeter' | 'building-perimeter' | 'canopy'` and 3–12 m `spacing_m` (0.75–12 m for canopy rows); or `decorated-canopy` with optional `trees: 'inside' | 'overlapping'`. The default `inside` selects tree centers inside the display polygon; `overlapping` also selects outside centers whose crown circle intersects the polygon. The existing bounded crown radius (half its diameter, clamped to 0.5–20 m) determines both overlap and the generated light-ring radius. Each tree produces one stable record, without adding a physical tree. This option stays pipeline-only. The default anchor is complete non-region park/paving geometry. A season may also define up to 16 unique sourced `grounds` areas (`id`, OSM way/relation `anchor`, simple closed `ring` of at most 64 positions, `sources`). An installation's optional `grounds` reference must share its anchor; the pipeline accepts a complete building/park/paving/road anchor and limits every boundary vertex to within 200 m of its center. Grounds are seasonal design envelopes, not permanent landcover or surveyed property boundaries. Restrict these envelopes to allowed display patches so owner-marked access/parking areas remain outside them. Canopy layouts require `mount: 'canopy'` and clip parallel rows to the polygon, including holes and concave access notches. Optional `bulb_spacing_m` (0.3–3 m) and `palette` (`warm` or `christmas`) bake into light-string records; omitted values retain the original sparse ornament pattern. Optional pipeline-only `light-string.exclude_tree_crowns: true` subtracts the union of nearby mapped/curated tree crown circles from each otherwise-admitted string. Both surviving ends remain when a string crosses a crown; unobstructed spans keep their exact geometry and identities. The radius is crown diameter/2 clamped to 0.5–20 m, matching decorated-canopy. The default retains complete strings. This clips only strings, without changing crown wraps or physical terrain. Row generation and renderer sampling are bounded.

Tree locations are deterministic clear spots, with at least 1 m between the footprint and paths, buildings (including a property anchor building), roads, monuments, existing trees, furniture and other seasonal trees. Missing anchors, invalid references, distant grounds, impossible footprints or absent mapped crowns fail the build. Path strings cross mapped walking routes; perimeter strings are inset 1 m and segmented at up to twice the configured spacing. Property strings reject entire spans intersecting buildings or road/driveway widths plus a 1 m buffer. Building-perimeter strings require a complete standing building with positive height and cannot use seasonal grounds. They follow every mapped facade with a 0.6 m parallel inward offset and trimmed corners; entire spans must stay inside the roof, including concave wings and holes. Their optional version-1 record `mount: "building"` is admitted only for the matching layout and renders above standing building cells using distinct fixture parts. Non-building strings may opt into `mount: "canopy"` for overhead ornaments that remain visible above foliage; their wires and ordinary hardware keep existing masking. This adds no ground obstacle and requires matching configuration admission. Omitted mounting retains ordinary string occlusion. All tree sizes and unsurveyed grounds/layouts must be described as illustrative in the pack.

A sourced `access-path` installation requires matching `grounds`, a `style` of `walkway`, `driveway` or `parking`, 2–32 nonrepeated consecutive geographic `points`, and `width_m` from 1–12 m (parking needs at least 5.5 m for parallel bays and access). The pipeline emits complete version-1 segments with `from`, `to`, style and metric width. Full-width envelopes distribute each segment across tiles and must remain wholly inside the grounds without overlapping mapped buildings or carriageways; parking uses flat rectangular ends. Tree placement conservatively reserves all configured access widths plus 1 m, independently of installation order; property strings retain 0.35 m clearance. These walkable, render-only surfaces do not add permanent landcover or simulated traffic routes. Rendered walks use narrow curbs and staggered paving joints rather than flat shade blocks; parking uses white bay markings and a separate access lane.

A sourced `carnival` installation requires a `grounds` reference and 1–48 uniquely identified `components`. Each component has `id`, `style` (`midway`, `carousel`, `ferris-wheel`, `bumper-cars` or `booth`), geographic `at`, metric `[width, length]` in `size_m`, and `angle_deg` (counterclockwise from east, −180–180). Sizes are 3–30 m for rides/booths, up to 120 m for the single optional midway; carousel dimensions must match. Complete footprints must stay within the grounds and clear mapped roads/paths, buildings, trees, monuments and other solid components by at least 1 m. The pipeline fails on occupied or out-of-bounds layouts. Exact version-1 `carnival` records reuse these fields plus stable installation/anchor/seed identities; full polygon envelopes distribute them across tiles. The layout is illustrative and cannot imply a surveyed parcel or an actual annual ride inventory.

Installations extend the same optional `seasons` layer with strict version-1 `christmas-tree`, `decorated-canopy`, `light-string`, `access-path` and `carnival` records. Display records retain exact geographic centers and radii; string records retain both endpoints, and all carry installation/anchor identities and a stable seed. Polygon envelopes cover neighboring tiles without replacing payload coordinates. Existing version-1 bunting records are unchanged. Physical trees and solid carnival ride/booth footprints enter the Life worker's seasonal ground geometry; overhead decorations and the walkable midway stay render-only. A new installation definition requires a tile rebuild as well as a web rebuild. Published previews/deployments need the newly generated archive published and pinned separately; code alone cannot add the geographic records to older archives.

## 5. Dating historical features — rules

- **Edit dates aren't build dates.** Never infer `start_year` from OSM edit history. OSM `start_date` tags may be used when present, with `certainty` derived from their format: `1954` → exact, `~1950` or `1950s` → circa.
- **Undated means always present.** Modern features without dates have no `start_year`. The UI legend explains that undated features show in all years.
- **Demolished features** go in content as standalone geometry. They are traced from old maps or imagery, with the tracing source recorded.
- **Old maps** are georeferenced in QGIS (Georeferencer) or Allmaps, exported as COG/XYZ, and listed in `content/cities/<slug>/historic-maps/*.json`, which records the year range covered, the source, and the permission.

## 6. Attribution

"© OpenStreetMap contributors" is always shown. Additional map credits stay one click away under "Sources" in a bounded, keyboard-accessible scrolling popover above the footer. Credits for base-map geometry, including curated vegetation and landmark details, remain available there at every zoom and with Life off or on. DEM attribution is retained when the generated base map uses it.

Credits for optional underlays and displayed media accompany that content:
- Satellite underlays: "Esri Wayback" or "Copernicus Sentinel-2" while the underlay is active
- Each photo and historic map: its own credit in the facts dialog while displayed

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

For emergency vehicles, configure `life.emergency`, verify eligible hospital/police/fire tags and station exclusions, then build step 08. Every configured kind must have a snapped target. The client disables emergencies when the optional file is unavailable or malformed.

### Optional ambient dialogue

Catalogs may override greeting periods with `periods: { morningStart, afternoonStart, eveningStart }`, using city-local integer minutes from 0 through 1439 in strictly increasing order. Defaults are 300, 720 and 1080 (05:00, 12:00, 18:00). Each period starts inclusively; evening continues across midnight until morning. Omitted periods preserve the defaults.


Add `packages/content/cities/<slug>/dialogue.json` to opt into human speech. `native` names the primary language (`code`, `label`); `translations` lists available secondary languages. `exchanges` contains unique scene IDs, a kind (`greet`, `talk`, `ball`, `look`, `cheer`), localized `lines`, and at least one `sources` record. A `cheer` is a one-line utterance called out by people at a running event: it takes only `conditions.occasions` (one or more of `procession`, `parade`, `fluvial`, `mass`, the event kinds), speaker slot 0 and no profile, and street moments never choose it. Greetings require `period: morning | afternoon | evening`. Delivery determines line counts: an `utterance` has one line; an `exchange` has two greeting or ball lines, or two to three conversation lines. Look reactions are utterances. Legacy entries infer exchange delivery except for look reactions. Every line must contain the native language and every offered translation, use declared city languages (English is implicit), and stay within 96 characters without line breaks. All language labels and text belong to the pack.

The content validator loads the optional catalog and fails on malformed or incomplete entries. Static page generation projects validated catalogs to `RuntimeDialogueCatalog`, stripping each exchange's editorial sources before passing speech text and metadata to client components. Full sources remain required in city packs. Dialogue changes need no tile regeneration or publishing. Cite linguistic references, and explain composed phrases in source notes. Ambient scripts describe illustrative encounters; they do not establish historical events or quote real residents.

Scenes may add a `profile` (scene category), `delivery`, `speakers` (one zero-based participant slot per turn), and `conditions`. Conditions match nearby anchor kinds, simulated weather, participant age mix and service/ball events. Metadata is optional for existing packs. Profiled scripts require explicit speaker roles and a compatible mechanism; vendor orders have two short exchange turns, while thanks may be a one-line utterance by the vendor. An utterance may use slot 1 without inventing a reply. Worker choices carry metadata, never localized strings. Naga's checks require exactly 104 scenes (42 utterances and 62 exchanges) with the documented category allocation, complete Bikol/English/Tagalog and no duplicate complete native scripts. Other cities retain the optional 1–120 catalog size. For dialogue JSON edits, run both `pnpm --filter @atlas/content exec vitest run src/validate.test.ts` (content invariants) and `pnpm --filter @atlas/renderer exec vitest run src/life/dialogue-catalog.test.ts` (all-city reachability), alongside pack validation as listed in `AGENTS.md`; dynamic JSON reads are not covered by Vitest's changed-file graph. Naga's `dialogue-review.md` documents composed wording, provenance and the outstanding native-speaker review.

## 9. Publishing tiles

Changes to lazy facts, drawings or tours require regeneration and publication, including updated `tiles.lock.json` entries for all three UI sidecars. Run `pnpm data:build -- --city <slug> --offline` (or `--from 04` when preceding intermediates exist), then `pnpm data:publish -- --city <slug>`, and commit the lock. Verify the locked downloads, not unlisted local outputs. Dialogue and city-Life configuration remain inline and still require a web build.


`data:publish` includes `<slug>.emergency.json` with other `<slug>.*` outputs. A committed emergency file can ship before the next owner-approved publication; `data:fetch --force` restores only lock-listed files and leaves unlisted optional outputs alone. Never edit generated graph geography by hand.

Generated files are gitignored (never commit tiles), so builds get them from GitHub releases instead:

- `pnpm data:publish [-- --city <slug>]` uploads a city's `apps/web/public/tiles/<slug>.*` (the output of `pnpm data:build`) as a new release `tiles-<slug>-<YYYYMMDD-HHMM>` (not marked latest), then writes `packages/content/cities/<slug>/tiles.lock.json`: the repository, the tag, and each file's sha256. Commit the lock. It needs the GitHub CLI logged in with write access, and does nothing if the files match the current lock.
- `pnpm data:fetch [-- --city <slug>] [--force]` downloads each locked city's missing files and checks each against its sha256 before writing it. Files that exist but differ from the lock (a local rebuild) are kept with a warning, unless `--force`. A city without a lock only warns. The web app's `build` fetches before rebuilding; unchanged exports skip both fetching and building. CI and Vercel fetch missing tiles on their own.
- Downloads use `GITHUB_TOKEN` (or `GH_TOKEN`, or the GitHub CLI's login) when available. This repository is public: without a token, downloads use public release URLs; with one, they use the GitHub API, which is required for private repositories. CI passes the workflow's token; Vercel needs a read-only token in its environment only for private repositories.
- The lock is validated with the city pack (`TilesLock` in `packages/shared`).
### Traffic enrichment

Traffic properties remain MVT scalars and are validated by shared schemas. Partial or inconsistent controller tags fail decode rather than silently becoming uncontrolled crossings.

| Property | Encoding and purpose |
| --- | --- |
| `crossing_signal` | Complete controller ID; ownership and phase association. |
| `crossing_signal_at` | Scalar JSON `[lng, lat]` retaining the pipeline controller coordinate exactly. |
| `crossing_signal_seed` | Exact uint32 canonical controller seed. |
| `crossing_mid` | `true` only for mid-block control; otherwise omitted. |
| `crossing_walk` | Pedestrian phase group opposite the crossed inbound group; mid-block always `a`. |
| `crossing_signal_control` | Validated scalar JSON copy of controller ID/coordinate/seed, axes/radius/provenance, and layout or exact stops, so buffered approaches remain controlled without the point feature. |
| `signal_seed` | Same uint32 seed on the controller feature, computed before tiling by the existing place hash on the z16 global integer grid in world Mercator metres. |
| `signal_stops` | Scalar JSON array of exact inbound arm records including position, width and local stop bearing for layout-free or mid-block controllers. |

Canonical seeds preserve the currently pinned Naga z16 phases and unify previously drifting z15 copies. Untagged archives keep their unsignalized crossing behavior; old controllers without a stored seed retain the original decoded-position fallback. Existing lamp seeds remain unchanged. Mapped stop nodes retain their sourced provenance and direction resolution, while controlled stop paint uses the safe exact approach setback above.

`01-fetch` saves a separate `detail-traffic.osm.json` node query for `highway=traffic_signals|crossing|stop`, `crossing`, and `crossing:markings`, preserving existing download caches. Tagged nodes win over skeletal way members when responses merge. Marked crossing nodes and signals use furniture variants; `footway=crossing` ways keep their path class and receive point stripe anchors in `lib/traffic.ts`. That resolver uses exact shared road vertices, snaps mapped signals within 30 m, derives signals only at four-arm mid/major intersections, suppresses nearby duplicates, and assigns a marked crossing only on the same owned road/path in the positive exterior direction, within radius plus 15 m and before another junction. Competing arms resolve by path distance, signal ID and arm key. Without a mapped candidate, a derived band is centered at radius plus 2 m; nearby crossings on other arms do not suppress it. Mid-block matching uses the nearest crossing on the same road within radius plus 3 m. Tiles carry crossing bearing/width/road and signal axes/radius/provenance from z15. `life.signals` supports `derive`, sourced `add` positions, and sourced `remove` targets by node ID or position. Phases and derived crossings are simulated, not surveyed traffic timings.

After direction overrides, `lib/signal-layout.ts` resolves each controller into validated `signal_layout` JSON metadata: member coordinates and exterior road arms with stable way IDs, travel direction, inbound/outbound eligibility, phase group, bearing, width, and optional exact stop position/width/local `stop_bearing`. The local containing segment supplies paint orientation, while the original arm bearing/toward still identifies the approach and vehicle-head anchor. Compatible degree-two way joins continue an arm with the same road class and traffic flow until a shared junction or genuine end, with cycle protection. A stop on a different way carries the complete optional `stop_road_id`, `stop_direction`, and `stop_road_width` tuple; runtime gates use that containing way while retaining the original controller phase and head identity. Old layouts without `stop_bearing` fall back to the arm bearing. Stop paint and vehicle gates share the exact stop; two-way runtime station projection first removes its quarter-road-width lateral paint offset, then accumulates the full polyline in either direction. Mid-block and layout-free controllers carry validated `signal_stops` JSON records; every legal mid-block inbound direction uses group a. Curated `life.signals.add` entries may list `linked_junctions`; every member must be a shared road vertex, connected to the primary member without an intervening unlisted junction, and owned by only one controller. Duplicate, missing, disconnected, or multiply owned members fail the build. Internal connecting arms produce no signal heads, stops, or derived crossings. Archives lacking the optional metadata retain legacy behavior.

### Neighborhood enrichment

The separate `detail-grounds.osm.json` query fetches `nwr["landuse"="recreation_ground"]` plus members in the city's detail bbox. Conversion merges it without changing the cached detail or neighborhood queries. These areas classify as grass unless a park tag takes precedence.

The separate `detail-pools.osm.json` query fetches `nwr["leisure"="swimming_pool"]`
and member geometry in the buffered detail bbox. Pools often lack `natural=water`, so
the ordinary water query does not find them. Conversion accepts an absent pool cache
for older cities; new fetches populate it. Pool areas use the existing `water_area`
class, while a tagged standing building keeps its building class. Existing detail
downloads remain reusable. A targeted primary OSM API download can seed an offline
cache when Overpass is unavailable; record its actual bounded query and provenance,
so it cannot masquerade as a complete citywide query on a later online fetch.

The separate `detail-neighborhood.osm.json` query fetches shops, selected food/service amenities, craft, scrub/heath, orchards, plant nurseries and cemeteries. `03-normalize` runs `lib/frontage.ts` while raw tags and building polygons still exist: a bbox grid and polygon containment associate shop nodes with footprints, including holes. Food wins over service, retail and generic commercial tags. Assigned nodes are suppressed as standalone markers; embedded malls/supermarkets retain the market class and contribute their names to unnamed footprints. Other shop points use furniture variants `shop_food`, `shop_retail`, `shop_service`; building roof variants stay intact. Tiles carry `frontage` as a separate property. Point shops share a 5 m radius with the renderer through `SHOP_POINT_RADIUS_M`; changing it requires regenerating their derived anchors. The worker packs frontage/kind bits without adding classes, caps shop lights and buffered commerce centers at 150 per tile, and transfers commerce separately for deterministic additive spawning.

Assignment chooses the smallest containing footprint, with stable OSM-id ties; outer boundaries are included and hole boundaries excluded. Commerce polygons otherwise lacking a render class become one interior point marker, retaining their OSM id and name. They annotate a building only if their whole area is contained in it. The shared `Frontage` schema validates the generated value; similarly named raw OSM annotations are ignored. `ShopAnchor` validates `shop_lng`, `shop_lat`, and `shop_radius_m` together. These are computed before clipping, from the largest polygon component's interior anchor (or a point's mapped position) and the full footprint's radius. Every tile copy uses that anchor, but only its containing tile owns the shop light. Commerce entries are deduplicated and capped by stable source id; older archives without anchors use the prior geometry fallback. Existing tile buffers bound the available proximity evidence; this does not promise complete shop coverage within 60 m beyond every tile edge.

### Derived multi-wing roofs

Step 04 adds optional scalar JSON `roof_plan` to standing buildings only. `RoofPlanSchema` and the worker's bounded validator share version 1: one `[lng, lat]` origin, at most seven forward-linked binary nodes, and at most four roof leaves. A split has `at` (local east/south meters), `angleDeg` (line direction in [0,180)), and `negative`/`positive` child indices. A leaf has `center`, `angleDeg`, `halfLengthM` and `halfWidthM`. Local coordinates and dimensions are bounded to 1,000 km, tree ownership is unique, and serialized input is capped at 4,096 characters. Unknown versions and malformed plans are ignored safely.

The pipeline analyzes collinearity at 0.3 m without changing the footprint. Candidates have at most 16 simplified vertices, at least 90% of perimeter aligned within 15 degrees of dominant orthogonal edges, and rectangularity below 0.85. Only convex off-axis bevels are admitted. Partition search uses that simplified analysis ring, so sub-tolerance survey noise does not become additional split candidates. Reflex-vertex cuts produce at most four leaves, each at least 3 m wide and 90% rectangular; selection favors fewer leaves, then better minimum rectangularity. Holes, multipolygons, flat roofs, grounds and unsupported shapes fall back. Coordinates are rounded to 0.1 m and angles to 0.01 degree. For cities with at least 200 standing buildings, enrichment fails if more than 10% get plans; smaller packs have no ratio gate. Stale generated plans are cleared before eligibility is evaluated. Tile records include the JSON only from z15, using nonoverlapping zoom ranges without duplicating a footprint at any zoom. Original geometry, identity, dates, labels and Life obstacles are unchanged.

Renderer defaults: absent roof shape becomes hipped; `flat`, `gabled`, `hipped` and `pyramidal` have explicit behavior; any other explicit shape falls back to gabled. These are illustrative inferences, not historical or surveyed facts. Landmark plan `at` anchors require a standing building; point monuments retain `offset_m`. Optional plan `credit` strings are deduplicated into city metadata attribution. Reference URLs and estimate qualifications remain in `sources`.

Rice-stage calendars are optional and carry their own sources. They follow the real city date, with stage progress across actual adjacent calendar years. Configured rice calendars are disclosed as illustrative in the farmland legend, without verification status metadata. Curated farmland uses the existing landuse layer/zoom band and receives ordinary farm places. Derivations must retain source permission, identifiers, acquisition dates, exclusions and territory checks; attribution alone does not license imagery extraction. Remove or subtract curated overlaps when OSM gains farmland: current merge warnings do not automatically replace those areas.

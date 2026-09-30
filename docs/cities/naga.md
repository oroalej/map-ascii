# City brief — Naga City

Naga City, Camarines Sur, Philippines is the **first city** in ASCII Atlas. Phases 1–6 of [`ROADMAP.md`](../ROADMAP.md) build the engine against it.

This brief holds everything Naga-specific. The generic docs (`SPEC.md`, `ARCHITECTURE.md`, `DATA.md`) describe behavior for any city and use Naga only as an example. The machine-readable version of this brief lives in `packages/content/cities/naga/city.json`. See `DATA.md` §4 for the `City` schema.

## 1. City config

| Field | Value |
|---|---|
| slug | `naga` |
| Display name | Naga City |
| Country | Philippines (Geofabrik `philippines` extract) |
| Boundary lookup | `relation["boundary"="administrative"]["name"="Naga City"]["admin_level"="6"]` within **Bicol Region** (OSM relation 3084673, verified 2026-09-29). Not within Camarines Sur: as an independent component city, Naga is cut out of the province polygon in OSM. |
| Detail buffer | 2 km around the city boundary, clipped to the region bbox below |
| Region | **Downtown only for now:** bbox `[123.170, 13.602, 123.213, 13.640]` (about 4.6 × 4.2 km: Balatas to the Felix Plazo St side, Liboton and Queborac Dr down to Almeda Hwy and the Milaor boundary). The whole Bicol Region view (OSM relation 3561455, which includes Masbate and Catanduanes) was too much to start with. The camera is clamped to the bbox, and detail data and search are limited to it. To widen it later, set `region` back to `{ "name": "Bicol Region", "osm_relation": "3561455" }`. |
| Subdivision | admin_level 10, local label **"barangay"** |
| Content languages | `en` (required), `fil` (Filipino), `bcl` (Bikol) |
| Smoke landmark | "Naga Metropolitan Cathedral" (e2e search target; OSM `alt_name` of way/23666715) |
| Focus | Plaza Quezon (way/201276958) at z17, between Plaza Rizal and Plaza Quince Martires. The boundary centroid is ~9 km east, on the slopes of Mt. Isarog, so the city needs an explicit focus. |
| Traffic | Jeepneys and cars lead on major roads, tricycles and motorcycles on secondary and side streets, with some bicycles; bancas on the Naga River; parked cars, motorcycles, and tricycles (`traffic` in `city.json`). This sets the look of the simulated life layer only. It is an impression, not traffic data. |
| Time zone | `Asia/Manila` (UTC+8, no daylight saving). The life layer's clock, fixed times of day, and seasons follow it. The daily rhythm is the engine's default working day until Naga's own (school hours, Mass times, market hours) is sourced. |
| Climate | The wind follows the monsoons: the amihan from the northeast (45°) November to March, the habagat from the southwest (225°) June to September, a light easterly between (`climate` in `city.json`, from PAGASA's climate notes). It moves the grass, trees, fields, and water; a storm (chosen in the HUD) brings rain. |

Apart from the downtown region bbox, coordinates, bounds, and the default camera are **not** listed here. The pipeline derives them from OSM (see `DATA.md` §2).

Seed landmarks (location and name only, sourced to OSM; dates and stories wait for real sources): Plaza Quezon, Plaza Rizal, Plaza Quince Martires, San Francisco Parish (OSM: "Parish of St. Francis of Assisi"), and the Naga Metropolitan Cathedral.

## 2. What each zoom level shows

| Level | Naga content |
|---|---|
| Region | *(Not reachable while the map is limited to downtown.)* Bicol coastline, Mt. Isarog, major lakes and rivers, terrain shading; province and major city labels |
| City | *(Mostly not reachable while the map is limited to downtown.)* Naga boundary, barangay outlines, Naga River, highways |
| District | The Centro, all roads, building blocks, parks |
| Street | Individual buildings and key street names (Magsaysay, Panganiban, Peñafrancia Avenue, Elias Angeles, General Luna…) in the Centro and the barangays |
| Place | Detailed landmarks such as the Basilica, the Cathedral, and the plazas: landmark names and walls, building outlines, and the named statues and memorials from OSM (e.g. Jose Rizal and Quince Martires in the plazas; St. John the Evangelist, St. Pedro Calungsod, and St. Peter Baptist in the Cathedral Grounds); roof ridges on pitched roofs; and draft plan-view parts (`packages/content/cities/naga/plans/`): the Cathedral's two front belfries, crossing dome, and cupolas, San Francisco Parish's dome and tower, the Quince Martires and Rizal monuments' tiered bases, the Coliseum's crown, and the Cathedral Grounds statues' pedestals; draft curated land cover (`packages/content/cities/naga/landcover/`, traced from Esri World Imagery because OSM maps none of it yet): trees in the Cathedral grounds and plaza, the Universidad de Santa Isabel courtyards, and the Archdiocese of Cáceres grounds (the grove south of the Archbishop's Residence as separate crowns), and the Cathedral's parking lot and plaza lawns |

## 3. Tours (launch set)

1. **Traslación route.** The procession path from the Basilica Minore of Our Lady of Peñafrancia to the Naga Metropolitan Cathedral, then the fluvial procession along the Naga River.
2. **Heritage Centro walk.** Plaza Quince Martires, Plaza Rizal, the Cathedral, and the old commercial streets.
3. **Campus belt.** Ateneo de Naga University, the University of Nueva Caceres, and the surrounding streets.
4. **From Isarog to the river.** A single flight from Region level down to street level. *Removed while the map is limited to downtown (its cameras leave the region). It's in git history, and it comes back when the map extends past downtown.*

Tour 2 is in the city pack (`packages/content/cities/naga/tours/`) as a draft: its camera path comes from the OSM data, and all narration is marked `TODO(verify)`. Tours 1 and 3 are Phase 5.

Tour narration must be fact-checked against sources before shipping. Draft text may use placeholders marked `TODO(verify)`.

## 4. Research backlog (content team)

Record each item in `packages/content/cities/naga/` with its sources:

- Founding and key dates for the Basilica Minore, the Naga Metropolitan Cathedral, Plaza Quince Martires, Plaza Rizal, the Naga City Hall, the public market, and the major bridges over the Naga River.
- Street renamings in the Centro.
- Survey which major and secondary roads have sidewalks, including side, width and separated footways, and record sources before enabling derived bands. Naga's pack explicitly sets `streets.sidewalks.derive: false` (project decision, 2026-09-30), so the map shows OSM-tagged sidewalks only. The cached candidate roads would otherwise imply about 119 km of sidewalk sides, exceeding this handoff's 40 km guard.
- The Peñafrancia Traslación and fluvial procession routes, including how they changed over time. The fluvial procession (`processions/penafrancia-fluvial.json`) is a draft: per the project owner, it departs from Danlugan ni Ina (OSM node 6791580317) and goes up the Naga River to the point nearest the Peñafrancia Basilica (way/23670362). That route needs a published source, and the date rule (now the Saturday before the third Sunday of September), start time (15:00), duration, and formation are placeholders, before it can be `verified`.
- When the railway (the Manila Railroad's line to Legazpi, now the PNR South Main Line) reached Naga, and when Naga Station (`landmarks/naga-station.json`, no date yet) opened and was rebuilt.
- Growth of the university belt.
- Major flood and typhoon events affecting the city.
- The life layer's schedules (`life.schedules` in `city.json`), which are left out until sourced, so Naga uses the defaults. Mass times at the Naga Metropolitan Cathedral and the Peñafrancia Basilica: third-party listings give the Cathedral's Sunday Masses as 04:30, 06:00, 07:30, 09:00, 10:30, 12:00, 15:30, 17:00, 18:30 and 20:00 ([masstimesph.com](https://masstimesph.com/bicol/camarines-sur/naga-city-st-john-the-evangelist-parish-naga-metropolitan-cathedral/), [philmass.com](https://www.philmass.com/Asia/Philippines/Camarines-Sur/Naga-City/Roman-Catholic-Churches/St.-John-the-Evangelist-Parish-(Naga-Metropolitan-Cathedral)/mass-schedule.html)). These need confirming with the parish, and the weekday Masses still need finding. The city's own page covers only the 2023 fiesta novena. The usual start and end of classes at Naga's public schools also need a source. TODO(verify)

## 5. Data notes

- **Plaza Quince Martires detail (draft).** `details/plaza-quince-martires.json` overrides the OSM plaza's ground with paving and adds four pedestrian routes, four curved seating edges, and six three-head lamp posts. `landcover/plaza-quince-martires.json` adds six individually sized broadleaved crowns and four raised lawn islands. These are illustrative estimates fitted to the OSM boundary from independently photographed Wikimedia Commons views by Patrick Roque (April 2023) and Ralff Nestor Nacor (August 2023), adapted under CC BY-SA 4.0 with credits in the map attribution. The monument plan adds an outer stepped apron and circular capital, confirmed by Nacor's December 2025 photograph. No Google screenshots were traced; the mapped flagpole stays at its OSM position. This is not a measured 2026 survey. Verify tree/fixture positions and dimensions on the ground before marking the records verified.

- Local life scenes use mapped bus stops, jeepney terminals, and gazebos. The pack identifies the mapped Milaor, Dinaga, Carolina/Panicuason, and Pacol terminals as jeepney sites, with links to their OSM nodes. Tricycle stands, covered entrances near the Centro, and terminal curb positions still need sourced surveys; unmapped sites are not guessed. Terminal service and animal presence are illustrative, not live transport or wildlife data.

- Check OpenHistoricalMap coverage for Naga, and contribute back.
- **Barangay boundaries are mostly unmapped (checked 2026-09-29).** Of the 27 barangays, only 3 (Abella, Dinaga, Santa Cruz) have admin_level 10 boundary relations. The rest are `place` nodes only. OSM also has admin_level 11 "Zone" relations. Point-in-polygon subdivision lookup covers only part of the city until this is solved (see ROADMAP open decisions).
- Copernicus DEM is used for the Mt. Isarog relief at Region level (not visible while the map is limited to downtown).
- Possible archive sources: local libraries, universities (Ateneo de Naga, UNC), the Archdiocese of Caceres and parish archives, and private collections. Written permission is required for anything that isn't public domain.
Traffic research: the pack currently supplies no signal overrides. Verify which junctions have operating signals before adding sourced overrides; the renderer's phases and derived signal locations are simulated. The September 30 local rebuild resolved 6 mapped and 30 derived signals, plus 88 mapped crossing anchors and 93 derived crossings.

Shop research: OSM shop coverage remains uneven; survey and map missing Centro shops before treating the decorative activity as evidence of real commerce. The local neighborhood rebuild identifies 98 food, 73 retail, 53 service and 18 generic commercial frontage buildings, plus 57 food, 79 retail and 46 service standalone markers.

Street detail: the September 30 rebuild retains 4.691 km of mapped sidewalk sides over 2.617 km of roads and derives none. It tags 146 one-way ways and adds 187 illustrative arrow anchors plus 120 signalized stop lines. No mapped stop line resolves: the single undirected mid-block stop node is skipped, as are four signal approaches shorter than their setback. Tiles are rebuilt locally and await publication.

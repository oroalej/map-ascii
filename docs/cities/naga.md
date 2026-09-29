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
- The Peñafrancia Traslación and fluvial procession routes, including how they changed over time. The fluvial procession (`processions/penafrancia-fluvial.json`) is a draft: it lands at Danlugan ni Ina (OSM node 6791580317), but its start (now a placeholder 1.2 km upstream), direction, date rule (now the Saturday before the third Sunday of September), start time (15:00), duration, and formation all need sources before it can be `verified`.
- Growth of the university belt.
- Major flood and typhoon events affecting the city.

## 5. Data notes

- Check OpenHistoricalMap coverage for Naga, and contribute back.
- **Barangay boundaries are mostly unmapped (checked 2026-09-29).** Of the 27 barangays, only 3 (Abella, Dinaga, Santa Cruz) have admin_level 10 boundary relations. The rest are `place` nodes only. OSM also has admin_level 11 "Zone" relations. Point-in-polygon subdivision lookup covers only part of the city until this is solved (see ROADMAP open decisions).
- Copernicus DEM is used for the Mt. Isarog relief at Region level (not visible while the map is limited to downtown).
- Possible archive sources: local libraries, universities (Ateneo de Naga, UNC), the Archdiocese of Caceres and parish archives, and private collections. Written permission is required for anything that isn't public domain.

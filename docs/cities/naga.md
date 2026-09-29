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
| Detail buffer | 2 km around the city boundary |
| Region | Bicol Region, OSM relation 3561455 (low-detail layers: coastline, major roads, water, place nodes). It includes Masbate and Catanduanes, so the region view is wider than the peninsula. |
| Subdivision | admin_level 10, local label **"barangay"** |
| Content languages | `en` (required), `fil` (Filipino), `bcl` (Bikol) |
| Smoke landmark | "Naga Metropolitan Cathedral" (e2e search target; OSM `alt_name` of way/23666715) |
| Focus | Plaza Quezon (way/201276958) at z17, between Plaza Rizal and Plaza Quince Martires. The boundary centroid is ~9 km east, on the slopes of Mt. Isarog, so the city needs an explicit focus. |

Coordinates, bounds, and the default camera are **not** listed here. The pipeline derives them from OSM (see `DATA.md` §2).

Seed landmarks (location and name only, sourced to OSM; dates and stories wait for real sources): Plaza Quezon, Plaza Rizal, Plaza Quince Martires, San Francisco Parish (OSM: "Parish of St. Francis of Assisi"), and the Naga Metropolitan Cathedral.

## 2. What each zoom level shows

| Level | Naga content |
|---|---|
| Region | Bicol coastline, Mt. Isarog, major lakes and rivers, terrain shading; province and major city labels |
| City | Naga boundary, barangay outlines, Naga River, highways |
| District | The Centro, all roads, building blocks, parks |
| Street | Individual buildings and street names in the Centro and the barangays |
| Place | Detailed landmarks such as the Basilica, the Cathedral, and the plazas |

## 3. Tours (launch set)

1. **Traslación route.** The procession path from the Basilica Minore of Our Lady of Peñafrancia to the Naga Metropolitan Cathedral, then the fluvial procession along the Naga River.
2. **Heritage Centro walk.** Plaza Quince Martires, Plaza Rizal, the Cathedral, and the old commercial streets.
3. **Campus belt.** Ateneo de Naga University, the University of Nueva Caceres, and the surrounding streets.
4. **From Isarog to the river.** A single flight from Region level down to street level.

Tour narration must be fact-checked against sources before shipping. Draft text may use placeholders marked `TODO(verify)`.

## 4. Research backlog (content team)

Record each item in `packages/content/cities/naga/` with its sources:

- Founding and key dates for the Basilica Minore, the Naga Metropolitan Cathedral, Plaza Quince Martires, Plaza Rizal, the Naga City Hall, the public market, and the major bridges over the Naga River.
- Street renamings in the Centro.
- The Peñafrancia Traslación and fluvial procession routes, including how they changed over time.
- Growth of the university belt.
- Major flood and typhoon events affecting the city.

## 5. Data notes

- Check OpenHistoricalMap coverage for Naga, and contribute back.
- **Barangay boundaries are mostly unmapped (checked 2026-09-29).** Of the 27 barangays, only 3 (Abella, Dinaga, Santa Cruz) have admin_level 10 boundary relations. The rest are `place` nodes only. OSM also has admin_level 11 "Zone" relations. Point-in-polygon subdivision lookup covers only part of the city until this is solved (see ROADMAP open decisions).
- Copernicus DEM is used for the Mt. Isarog relief at Region level.
- Possible archive sources: local libraries, universities (Ateneo de Naga, UNC), the Archdiocese of Caceres and parish archives, and private collections. Written permission is required for anything that isn't public domain.

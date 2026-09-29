# City brief — Naga City

Naga City, Camarines Sur, Philippines is the **first city** in ASCII Atlas. Phases 1–6 of [`ROADMAP.md`](../ROADMAP.md) build the engine against it.

This brief holds everything Naga-specific. The generic docs (`SPEC.md`, `ARCHITECTURE.md`, `DATA.md`) describe behavior for any city and use Naga only as an example. The machine-readable version of this brief lives in `packages/content/cities/naga/city.json` (created in Phase 1). See `DATA.md` §4 for the `City` schema.

## 1. City config

| Field | Value |
|---|---|
| slug | `naga` |
| Display name | Naga City |
| Country | Philippines (Geofabrik `philippines` extract) |
| Boundary lookup | `relation["boundary"="administrative"]["name"="Naga"]["admin_level"="6"]` inside Camarines Sur. Verify the admin_level against the data. |
| Detail buffer | 2 km around the city boundary |
| Region | Bicol peninsula (low-detail layers: coastline, major roads, water, place nodes) |
| Subdivision | admin_level 10, local label **"barangay"** |
| Content languages | `en` (required), `fil` (Filipino), `bcl` (Bikol) |
| Smoke landmark | "Naga Metropolitan Cathedral" (e2e search target) |

Coordinates, bounds, and the default camera are **not** listed here. The pipeline derives them from OSM (see `DATA.md` §2).

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
- Copernicus DEM is used for the Mt. Isarog relief at Region level.
- Possible archive sources: local libraries, universities (Ateneo de Naga, UNC), the Archdiocese of Caceres and parish archives, and private collections. Written permission is required for anything that isn't public domain.

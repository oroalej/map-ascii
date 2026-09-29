# @atlas/data

The data pipeline behind `pnpm data:build`. See [`docs/DATA.md`](../../docs/DATA.md) for the full design.

The pipeline is city-agnostic. It reads each city pack from `packages/content/cities/<slug>/` and validates every pack before running.

```
pnpm data:build                              # every registered city
pnpm data:build -- --city naga               # one city
pnpm data:build -- --city naga --offline     # cached downloads only
pnpm data:build -- --city naga --from 03     # rerun from a step (earlier outputs must exist)
```

| Step | Does |
|---|---|
| `01-fetch` | Look up the boundary relation (must match exactly one), then download OSM for the buffered boundary bbox, the region's low-detail layers (per region part), and the Copernicus DEM GLO-90 tiles for the region into `raw/<city>/`. Downloads are cached for 7 days. |
| `02-convert` | OSM → GeoJSON (`osmtogeojson`); derive the sea (from the coastline), province label points, and terrain bands (from the DEM); derive the boundary bbox, region bounds, default view (the `focus` feature, else the boundary centroid), and attribution |
| `03-normalize` | Map OSM tags to atlas classes, tile layers, and zoom bands, and compute heights, widths, ids, OSM dates, and subdivisions (mapped boundaries, else approximate areas from `place` nodes) |
| `04-merge-content` | Join the city pack's landmarks onto features by `osm_id`, add plan-view landmark parts from `plans/`, and write `<city>.art.json` from `art/` |
| `05-tiles` | Build `<city>.pmtiles` (z6–z16) with tippecanoe, and write it, `<city>.meta.json`, and `<city>.subdivisions.json` to `apps/web/public/tiles/` |
| `06-search-index` | Build `<city>.search-index.json`: entries plus a serialized MiniSearch index |

`raw/` and `build/` are gitignored. Never hand-edit generated tiles.

## Publishing and fetching tiles

The generated files are gitignored too. `pnpm data:publish -- --city <slug>` uploads them as a GitHub release and writes the city pack's `tiles.lock.json` (commit it); `pnpm data:fetch` downloads the locked files that are missing, checking their hashes, and runs before every web build. See [`docs/DATA.md`](../../docs/DATA.md) §9.

Overpass: the public instances are tried in turn, with backoff when they are busy (HTTP 429/504). Set `OVERPASS_URL` to pin one.

## Tests

`scripts/pipeline.test.ts` runs steps 02–04 on a small fixture extract (`scripts/__fixtures__/raw/`) with a fixture city, so it needs no network. `scripts/lib/lib.test.ts` covers the class mapping, date parsing, and bbox math.

## tippecanoe

Step 05 uses a native `tippecanoe` if it is on `PATH`. Otherwise it builds and runs the Docker image in [`docker/`](docker/Dockerfile) (tippecanoe 2.79.0), so on Windows you only need Docker Desktop running. The first run builds the image, which takes a few minutes. If Docker Desktop is installed but not running, the pipeline starts it with `docker desktop start`. If step 05 still fails, start Docker Desktop yourself and resume with `pnpm data:build -- --city <slug> --from 05`.

No GDAL is needed: the DEM GeoTIFFs are read with `geotiff` and contoured with `d3-contour` in Node.

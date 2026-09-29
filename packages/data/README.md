# @atlas/data

The data pipeline behind `pnpm data:build`. See [`docs/DATA.md`](../../docs/DATA.md) for the full design.

The pipeline is city-agnostic. It reads each city's config from `packages/content/cities/<slug>/city.json`. `pnpm data:build -- --city <slug>` builds one city, and with no flag it builds all registered cities (the `--city` flag arrives in Phase 1).

| Step | Does |
|---|---|
| `01-fetch` | Download OSM (city detail + Region bboxes from `city.json`) and DEM tiles into `raw/<city>/` |
| `02-convert` | OSM → GeoJSON; DEM → hillshade PNG tiles |
| `03-normalize` | Map OSM tags to atlas classes, compute heights, ids, and subdivisions |
| `04-merge-content` | Validate the city pack and join curated records onto features |
| `05-tiles` | Build `<city>.pmtiles` and `<city>.meta.json`, and copy them to `apps/web/public/tiles/` |
| `06-search-index` | Build `<city>.search-index.json` |

`raw/` and `build/` are gitignored. Never hand-edit generated tiles.

## Status

Phase 0: every step is a stub except content validation in `04-merge-content`. The steps are implemented in Phase 1, with Naga City as the first city.

## Required CLI tools (from Phase 1)

- [tippecanoe](https://github.com/felt/tippecanoe) — vector tiles
- [GDAL](https://gdal.org/) — DEM hillshade (`gdaldem`)
- optional: [osmium-tool](https://osmcode.org/osmium-tool/) for PBF extracts, and the [pmtiles CLI](https://github.com/protomaps/go-pmtiles)

On Windows, run the pipeline in WSL or Docker; tippecanoe has no native Windows build. Install steps and a Dockerfile come with Phase 1.

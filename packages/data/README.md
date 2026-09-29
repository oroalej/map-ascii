# @naga/data

The data pipeline behind `pnpm data:build`. See [`docs/DATA.md`](../../docs/DATA.md) for the full design.

| Step | Does |
|---|---|
| `01-fetch` | Download OSM (Naga detail + Region bboxes) and DEM tiles into `raw/` |
| `02-convert` | OSM → GeoJSON; DEM → hillshade PNG tiles |
| `03-normalize` | Map OSM tags to atlas classes, compute heights, ids, and barangays |
| `04-merge-content` | Validate `packages/content` and join curated records onto features |
| `05-tiles` | Build `naga.pmtiles` and copy it to `apps/web/public/tiles/` |
| `06-search-index` | Build `search-index.json` |

`raw/` and `build/` are gitignored. Never hand-edit generated tiles.

## Status

Phase 0: every step is a stub except content validation in `04-merge-content`. The steps are implemented in Phase 1.

## Required CLI tools (from Phase 1)

- [tippecanoe](https://github.com/felt/tippecanoe) — vector tiles
- [GDAL](https://gdal.org/) — DEM hillshade (`gdaldem`)
- optional: [osmium-tool](https://osmcode.org/osmium-tool/) for PBF extracts, and the [pmtiles CLI](https://github.com/protomaps/go-pmtiles)

On Windows, run the pipeline in WSL or Docker; tippecanoe has no native Windows build. Install steps and a Dockerfile come with Phase 1.

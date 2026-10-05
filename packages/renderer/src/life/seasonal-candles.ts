/** Geographic graves and illustrative memorial sites share deterministic seasonal admission. */
import earcut from 'earcut';
import { offsetUtility, SEASON_ZOOM } from '@atlas/shared';
import {
  EXTENT,
  MERCATOR_METERS,
  hashString,
  metersPerUnit,
  ringCentroid,
  tileToLngLat,
} from '../raster/geometry';
import type { TileId } from '../tiles';
import { inTile, type LifeGeometry } from './geometry';
import { bodyInside, boundsOf, PolygonIndex, type Point } from './occupancy';
import { prepareRoadTerrain, transformPolygon } from './terrain';
import { LampState, type VisibleLamp } from './lights';
import { project } from '../camera';
import type { SeasonalFixture } from './seasonal';

type MemorialAnchor = Point & { seed: number; memorial?: string };
export type CandleFixture = { kind: 'season-candle'; at: [number, number]; seed: number };
const cache = new WeakMap<LifeGeometry, Map<string, readonly MemorialAnchor[]>>();
const MAX_FALLBACK = 32;
const LATTICE_METERS = 24;

function anchors(tile: TileId, geo: LifeGeometry): readonly MemorialAnchor[] {
  const key = `${tile.z}/${tile.x}/${tile.y}`;
  let entries = cache.get(geo);
  if (!entries) cache.set(geo, (entries = new Map<string, readonly MemorialAnchor[]>()));
  const saved = entries.get(key);
  if (saved) return saved;
  const result: MemorialAnchor[] = [];
  for (let i = 0; i < (geo.graves?.length ?? 0); i += 3)
    result.push({ x: geo.graves![i]!, y: geo.graves![i + 1]!, seed: geo.graves![i + 2]! });
  if (geo.memorialSites) {
    for (let i = 0; i < geo.memorialSites.length; i += 3)
      result.push({
        x: geo.memorialSites[i]!,
        y: geo.memorialSites[i + 1]!,
        seed: geo.memorialSites[i + 2]!,
        memorial: geo.memorialFragments?.[i / 3],
      });
    entries.set(key, result);
    return result;
  }
  const fragments = geo.cemeteryAreas?.filter((area) => !area.hasBurials) ?? [];
  if (fragments.length) {
    const unit = metersPerUnit(tile);
    const metric = (rings: readonly (readonly Point[])[]) => transformPolygon(rings, 0, 0, unit);
    const unsafe = new PolygonIndex();
    for (const area of geo.areas ?? [])
      if (
        area.kind === 'blocked' ||
        area.kind === 'vehicle-blocked' ||
        area.kind === 'parking-exclusion'
      )
        unsafe.add(metric(area.rings));
    for (const rings of prepareRoadTerrain(geo, 1 / unit).roads) unsafe.add(rings);
    // A fixed equatorial spacing aligns the lattice across tile rows and archive zooms.
    const step = (LATTICE_METERS * EXTENT * 2 ** tile.z) / MERCATOR_METERS;
    const groups: MemorialAnchor[][] = [];
    for (const area of fragments) {
      if (!area.rings[0]?.length) continue;
      const polygon = metric(area.rings);
      const safe = (p: Point) => {
        if (!inTile(p)) return false;
        const body = { x: p.x * unit, y: p.y * unit, hx: 1, hy: 0, length: 0.25, width: 0.25 };
        if (!bodyInside(body, polygon) || unsafe.hits([body])) return false;
        for (let i = 0; i < geo.perches.length; i += 2)
          if (Math.hypot(p.x - geo.perches[i]!, p.y - geo.perches[i + 1]!) * unit < 2) return false;
        return true;
      };
      const site = (p: Point): MemorialAnchor => {
        const identity = `${area.id}/${Math.round(tile.x * EXTENT + p.x)}/${Math.round(tile.y * EXTENT + p.y)}`;
        return { ...p, seed: hashString(identity) & 0xffffff, memorial: area.id };
      };
      const [left, top, right, bottom] = boundsOf(area.rings[0]);
      const candidates: MemorialAnchor[] = [];
      for (
        let wy = Math.ceil((tile.y * EXTENT + Math.max(0, top)) / step);
        wy * step < tile.y * EXTENT + Math.min(EXTENT, bottom);
        wy++
      )
        for (
          let wx = Math.ceil((tile.x * EXTENT + Math.max(0, left)) / step);
          wx * step < tile.x * EXTENT + Math.min(EXTENT, right);
          wx++
        ) {
          const p = { x: wx * step - tile.x * EXTENT, y: wy * step - tile.y * EXTENT };
          if (safe(p)) candidates.push(site(p));
        }
      if (!candidates.length) {
        const center = ringCentroid(area.rings[0]);
        if (safe(center)) candidates.push(site(center));
        else {
          const coords = area.rings.flatMap((ring) => ring.flatMap((p) => [p.x, p.y]));
          const holes: number[] = [];
          let offset = area.rings[0].length;
          for (const ring of area.rings.slice(1)) {
            holes.push(offset);
            offset += ring.length;
          }
          const triangles = earcut(coords, holes, 2);
          for (let i = 0; i < Math.min(triangles.length, 768); i += 3) {
            const p = { x: 0, y: 0 };
            for (let v = 0; v < 3; v++) {
              p.x += coords[triangles[i + v]! * 2]! / 3;
              p.y += coords[triangles[i + v]! * 2 + 1]! / 3;
            }
            if (safe(p)) {
              candidates.push(site(p));
              break;
            }
          }
        }
      }
      candidates.sort((a, b) => a.seed - b.seed || a.x - b.x || a.y - b.y);
      if (candidates.length) groups.push(candidates);
    }
    groups.sort((a, b) => {
      const left = a[0]!.memorial!,
        right = b[0]!.memorial!;
      return (left < right ? -1 : left > right ? 1 : 0) || a[0]!.seed - b[0]!.seed;
    });
    // Give each safe fragment a site before filling remaining bounded capacity.
    const fallback = groups.slice(0, MAX_FALLBACK).map((group) => group[0]!);
    for (const group of groups)
      for (const p of group.slice(1)) {
        if (fallback.length >= MAX_FALLBACK) break;
        fallback.push(p);
      }
    result.push(...fallback);
  }
  entries.set(key, result);
  return result;
}

/** Tile-worker preparation; consumers share bounded sites without rebuilding terrain indexes. */
export function prepareMemorialSites(tile: TileId, geo: LifeGeometry): void {
  if (geo.memorialSites) return;
  const sites = geo.cemeteryAreas?.some((area) => !area.hasBurials)
    ? anchors(tile, geo).filter((p) => p.memorial !== undefined)
    : [];
  geo.memorialSites = Float32Array.from(sites.flatMap((p) => [p.x, p.y, p.seed]));
  geo.memorialFragments = sites.map((p) => p.memorial!);
  // Both inline and structured-cloned consumers use exactly the transferred precision.
  cache.delete(geo);
}

export function memorialAnchors(
  tile: TileId,
  geo: LifeGeometry,
  share: number,
): readonly MemorialAnchor[] {
  if (!(share > 0)) return [];
  const sites = anchors(tile, geo);
  const selected = sites.filter((p) => p.seed / 0x1000000 < share);
  const represented = new Set(selected.flatMap((p) => (p.memorial ? [p.memorial] : [])));
  for (const p of sites)
    if (p.memorial && !represented.has(p.memorial)) {
      selected.push(p);
      represented.add(p.memorial);
    }
  return selected;
}

export function candleFixtures(tile: TileId, geo: LifeGeometry, share: number): CandleFixture[] {
  return memorialAnchors(tile, geo, share).map((p) => ({
    kind: 'season-candle',
    at: tileToLngLat(tile, p),
    seed: p.seed,
  }));
}

const lampCache = new WeakMap<readonly SeasonalFixture[], readonly VisibleLamp[]>();
export function candleLamps(
  fixtures: readonly SeasonalFixture[],
  zoom: number,
): readonly VisibleLamp[] {
  if (zoom < SEASON_ZOOM.installationLights.min) return [];
  const saved = lampCache.get(fixtures);
  if (saved) return saved;
  const lamps = fixtures
    .filter((f): f is CandleFixture => f.kind === 'season-candle')
    .map(({ at, seed }) => {
      const east = offsetUtility(at, 1.2, 0),
        north = offsetUtility(at, 0, 1.2);
      const [x, y] = project(...at, 0),
        [ex] = project(...east, 0),
        [, ny] = project(...north, 0);
      return {
        lng: at[0],
        lat: at[1],
        center: at,
        pool: at,
        east,
        north,
        worldPool: [x, y, Math.abs(ex - x), Math.abs(ny - y)] as const,
        state: LampState.candle,
        seed: seed & 31,
        headless: true,
      };
    });
  lampCache.set(fixtures, lamps);
  return lamps;
}

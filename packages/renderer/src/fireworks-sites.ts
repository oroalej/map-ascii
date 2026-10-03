import { TILE_EXTENT } from '@atlas/shared';
import { TILE_SIZE } from './camera';
import type { TilePoint } from './raster/geometry';
import type { TileId } from './tiles';

/** Explicit OSM residential kinds retained in existing tiles; unknown buildings stay excluded. */
export const isResidentialBuilding = (kind: unknown): boolean =>
  typeof kind === 'string' &&
  /^building=(house|residential|apartments|terrace|detached|semidetached_house|bungalow|dormitory|static_caravan)$/.test(
    kind,
  );

export type ResidentialSite = TilePoint & { id: number };
export type FireworkBounds = { left: number; top: number; right: number; bottom: number };
export type FireworkSiteSampler = (
  bounds: FireworkBounds,
  random: () => number,
  occupied: ReadonlySet<number>,
) => ResidentialSite | undefined;
export const NO_FIREWORK_SITES: FireworkSiteSampler = () => undefined;

/** Small untyped roofs need neighborhood evidence; large blocks and tiny sheds don't qualify. */
export function isCompactRoof(
  points: readonly TilePoint[],
  triangles: readonly number[],
  meters: number,
): boolean {
  let area = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = points[triangles[i]!],
      b = points[triangles[i + 1]!],
      c = points[triangles[i + 2]!];
    if (!a || !b || !c) return false;
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  area *= meters * meters;
  return Number.isFinite(area) && meters > 0 && area >= 20 && area <= 450;
}

/** Infer a neighborhood only from compact roof clusters beside explicitly residential streets. */
export function neighborhoodSites(
  roofs: readonly ResidentialSite[],
  mapped: readonly ResidentialSite[],
  streets: readonly (readonly TilePoint[])[],
  meters: number,
): ResidentialSite[] {
  if (!Number.isFinite(meters) || meters <= 0 || !streets.length) return [];
  const reach = 35 / meters,
    spacing = 60 / meters;
  const nearby = roofs.filter((roof) =>
    streets.some((street) => {
      for (let i = 1; i < street.length; i++) {
        const a = street[i - 1]!,
          b = street[i]!;
        const dx = b.x - a.x,
          dy = b.y - a.y;
        const length = dx * dx + dy * dy;
        const t = length
          ? Math.max(0, Math.min(1, ((roof.x - a.x) * dx + (roof.y - a.y) * dy) / length))
          : 0;
        if ((roof.x - a.x - t * dx) ** 2 + (roof.y - a.y - t * dy) ** 2 <= reach * reach)
          return true;
      }
      return false;
    }),
  );
  const bins = new Map<string, ResidentialSite[]>();
  const members = new Map([...mapped, ...nearby].map((site) => [site.id, site]));
  for (const site of members.values()) {
    const key = `${Math.floor(site.x / spacing)}/${Math.floor(site.y / spacing)}`;
    const bin = bins.get(key) ?? [];
    bin.push(site);
    bins.set(key, bin);
  }
  return nearby.filter((site) => {
    const x = Math.floor(site.x / spacing),
      y = Math.floor(site.y / spacing);
    let neighbors = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of bins.get(`${x + dx}/${y + dy}`) ?? []) {
          if (
            site.id !== other.id &&
            (site.x - other.x) ** 2 + (site.y - other.y) ** 2 <= spacing * spacing &&
            ++neighbors >= 2
          )
            return true;
        }
      }
    return false;
  });
}

/** The largest owned triangle's centroid stays inside the footprint, including concavities/holes. */
export function residentialSite(
  id: number,
  points: readonly TilePoint[],
  triangles: readonly number[],
  extent: number,
): ResidentialSite | undefined {
  let best: ResidentialSite | undefined;
  let area = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = points[triangles[i]!],
      b = points[triangles[i + 1]!],
      c = points[triangles[i + 2]!];
    if (!a || !b || !c) continue;
    const size = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const x = (a.x + b.x + c.x) / 3,
      y = (a.y + b.y + c.y) / 3;
    if (Number.isFinite(size) && size > area && x >= 0 && y >= 0 && x < extent && y < extent) {
      best = { id, x, y };
      area = size;
    }
  }
  return best;
}

/** Compile per tile-set change; prefer deeper copies of the same buffered feature. */
export function residentialFireworkSites(
  tiles: readonly { tile: TileId; sites: readonly ResidentialSite[] }[],
  referenceZoom: number,
): FireworkSiteSampler {
  const sites = new Map<number, ResidentialSite>();
  const worldSize = TILE_SIZE * 2 ** referenceZoom;
  for (const { tile, sites: local } of [...tiles].sort((a, b) => b.tile.z - a.tile.z)) {
    const tileSize = worldSize / 2 ** tile.z;
    for (const point of local) {
      if (sites.has(point.id)) continue;
      const x = (tile.x + point.x / TILE_EXTENT) * tileSize;
      const y = (tile.y + point.y / TILE_EXTENT) * tileSize;
      if (Number.isFinite(x) && Number.isFinite(y)) sites.set(point.id, { id: point.id, x, y });
    }
  }
  const candidates = [...sites.values()];
  return (bounds, random, occupied) => {
    // Uniform reservoir sampling over homes, independent of tile/feature order.
    let chosen: ResidentialSite | undefined,
      count = 0;
    for (const site of candidates) {
      if (
        !occupied.has(site.id) &&
        site.x >= bounds.left &&
        site.x <= bounds.right &&
        site.y >= bounds.top &&
        site.y <= bounds.bottom &&
        random() * ++count < 1
      )
        chosen = site;
    }
    return chosen;
  };
}

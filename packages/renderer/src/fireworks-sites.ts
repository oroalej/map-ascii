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
export const isResidentialStreet = (className: unknown, kind: unknown): boolean =>
  className === 'road_minor' &&
  (kind === 'highway=residential' || kind === 'highway=living_street');
export const isRoofCandidate = (
  className: unknown,
  kind: unknown,
  height: number,
  landmark: boolean,
): boolean => className === 'building' && kind === 'building=yes' && height > 0 && !landmark;

export type ResidentialSite = TilePoint & { id: number };
/** Triples of feature id and tile-local x/y; transferred without object cloning. */
export type ResidentialSites = Float64Array;
export function packResidentialSites(sites: readonly ResidentialSite[]): ResidentialSites {
  const out = new Float64Array(sites.length * 3);
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]!;
    out[i * 3] = site.id;
    out[i * 3 + 1] = site.x;
    out[i * 3 + 2] = site.y;
  }
  return out;
}

type Bins<T> = Map<number, Map<number, T[]>>;
function bin<T>(bins: Bins<T>, x: number, y: number): T[] {
  let column = bins.get(x);
  if (!column) bins.set(x, (column = new Map<number, T[]>()));
  let found = column.get(y);
  if (!found) column.set(y, (found = []));
  return found;
}
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
  type Segment = { a: TilePoint; dx: number; dy: number; length: number };
  const segments: Bins<Segment> = new Map();
  for (const street of streets)
    for (let i = 1; i < street.length; i++) {
      const a = street[i - 1]!,
        b = street[i]!;
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const segment = { a, dx, dy, length: dx * dx + dy * dy };
      let x = Math.floor(a.x / reach),
        y = Math.floor(a.y / reach);
      const endX = Math.floor(b.x / reach),
        endY = Math.floor(b.y / reach);
      const stepX = Math.sign(dx),
        stepY = Math.sign(dy);
      const deltaX = dx ? reach / Math.abs(dx) : Infinity;
      const deltaY = dy ? reach / Math.abs(dy) : Infinity;
      let nextX = dx ? ((x + (dx > 0 ? 1 : 0)) * reach - a.x) / dx : Infinity;
      let nextY = dy ? ((y + (dy > 0 ? 1 : 0)) * reach - a.y) / dy : Infinity;
      // Visit crossed cells, rather than a long diagonal's entire bounding rectangle.
      for (;;) {
        bin(segments, x, y).push(segment);
        if (x === endX && y === endY) break;
        const crossX = nextX <= nextY,
          crossY = nextY <= nextX;
        if (crossX) {
          x += stepX;
          nextX += deltaX;
        }
        if (crossY) {
          y += stepY;
          nextY += deltaY;
        }
      }
    }
  const nearby = roofs.filter((roof) => {
    const x = Math.floor(roof.x / reach),
      y = Math.floor(roof.y / reach);
    for (let by = -1; by <= 1; by++)
      for (let bx = -1; bx <= 1; bx++)
        for (const { a, dx, dy, length } of segments.get(x + bx)?.get(y + by) ?? []) {
          const t = length
            ? Math.max(0, Math.min(1, ((roof.x - a.x) * dx + (roof.y - a.y) * dy) / length))
            : 0;
          if ((roof.x - a.x - t * dx) ** 2 + (roof.y - a.y - t * dy) ** 2 <= reach * reach)
            return true;
        }
    return false;
  });
  const bins: Bins<ResidentialSite> = new Map();
  const members = new Map([...mapped, ...nearby].map((site) => [site.id, site]));
  for (const site of members.values()) {
    bin(bins, Math.floor(site.x / spacing), Math.floor(site.y / spacing)).push(site);
  }
  return nearby.filter((site) => {
    const x = Math.floor(site.x / spacing),
      y = Math.floor(site.y / spacing);
    let neighbors = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of bins.get(x + dx)?.get(y + dy) ?? []) {
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
  tiles: readonly { tile: TileId; sites: ResidentialSites }[],
  referenceZoom: number,
): FireworkSiteSampler {
  const sites = new Map<number, ResidentialSite>();
  const worldSize = TILE_SIZE * 2 ** referenceZoom;
  for (const { tile, sites: local } of [...tiles].sort((a, b) => b.tile.z - a.tile.z)) {
    const tileSize = worldSize / 2 ** tile.z;
    for (let at = 0; at < local.length; at += 3) {
      const id = local[at]!;
      if (sites.has(id)) continue;
      const x = (tile.x + local[at + 1]! / TILE_EXTENT) * tileSize;
      const y = (tile.y + local[at + 2]! / TILE_EXTENT) * tileSize;
      if (Number.isFinite(x) && Number.isFinite(y)) sites.set(id, { id, x, y });
    }
  }
  const cell = worldSize / 2 ** 16;
  const bins: Bins<ResidentialSite> = new Map();
  const owner = new Map<number, { members: ResidentialSite[]; index: number }>();
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const site of sites.values()) {
    const x = Math.floor(site.x / cell),
      y = Math.floor(site.y / cell);
    const members = bin(bins, x, y);
    owner.set(site.id, { members, index: members.length });
    members.push(site);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return (bounds, random, occupied) => {
    // Rebuild from the mutable set so same-set additions/removals cannot stale a count.
    const blockedByBin = new Map<ResidentialSite[], number[]>();
    for (const id of occupied) {
      const entry = owner.get(id);
      if (!entry) continue;
      let blocked = blockedByBin.get(entry.members);
      if (!blocked) blockedByBin.set(entry.members, (blocked = []));
      blocked.push(entry.index);
    }
    // Uniform reservoir sampling over homes, independent of tile/feature order.
    let chosen: ResidentialSite | undefined,
      count = 0;
    const left = Math.max(minX, Math.floor(bounds.left / cell)),
      right = Math.min(maxX, Math.floor(bounds.right / cell));
    const top = Math.max(minY, Math.floor(bounds.top / cell)),
      bottom = Math.min(maxY, Math.floor(bounds.bottom / cell));
    for (const [x, column] of bins) {
      if (x < left || x > right) continue;
      for (const [y, members] of column) {
        if (y < top || y > bottom) continue;
        if (
          x * cell >= bounds.left &&
          (x + 1) * cell <= bounds.right &&
          y * cell >= bounds.top &&
          (y + 1) * cell <= bounds.bottom
        ) {
          const blocked = blockedByBin.get(members) ?? [];
          const available = members.length - blocked.length;
          if (!available) continue;
          count += available;
          if (random() * count < available) {
            // Map a uniform free ordinal past occupied positions without rejection retries.
            blocked.sort((a, b) => a - b);
            let index = Math.floor(random() * available);
            for (const occupiedIndex of blocked) if (occupiedIndex <= index) index++;
            chosen = members[index]!;
          }
          continue;
        }
        for (const site of members) {
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
      }
    }
    return chosen;
  };
}

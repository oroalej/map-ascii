/** Stateless crowd raster candidates. No population, owners, inspection or worker agents. */
import { localMetricProjection, PROCESSION_GEOMETRY, type ProcessionRoute } from '@atlas/shared';
import type { GridPlacement } from '../grid';
import type { VisibleAgent } from './simulate';
import {
  eventGroundAllows,
  eventGroundBounds,
  groundForRoute,
  type EventGround,
  streetSidewalks,
} from './ground-events';
import { CrowdMaskRaster } from './crowd-mask';
import { formationLayout } from './formation-layout';
import { PROCESSION, routePolyline } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { figureFit } from './people';
export const MAX_THRONG_CELLS = 16000;
export const THRONG_MASK_SIDE = 16;
export type ThrongCell = {
  col: number;
  row: number;
  agent: VisibleAgent;
  mask?: Uint32Array;
  hash: number;
};
export type ThrongPayload = { cells: ThrongCell[]; cap: number };
type Point = [number, number];
type RouteIndex = {
  frame: ReturnType<typeof localMetricProjection>;
  line: ReturnType<typeof routePolyline>;
  bins: Map<number, Map<number, number[]>>;
  visited: Uint32Array;
  epoch: number;
  origin: Point;
  kx: number;
  ky: number;
  segments: { x: number; y: number; dx: number; dy: number; length: number; along: number }[];
  nearest: {
    s: number;
    off: number;
    segment: number;
    target: Point;
    distance2: number;
    x: number;
    y: number;
  };
};
const routes = new WeakMap<ProcessionRoute, RouteIndex>();
const mix = (x: number, y: number) => {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
};
function routeIndex(event: Exclude<ProcessionRoute, { kind: 'mass' }>) {
  let index = routes.get(event);
  if (index) return index;
  const frame = localMetricProjection(event.route[0]!),
    line = routePolyline(event.route.map(frame.to)),
    bins: RouteIndex['bins'] = new Map();
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1]!,
      b = line.points[i]!;
    for (
      let y = Math.floor(Math.min(a[1], b[1]) / 32);
      y <= Math.floor(Math.max(a[1], b[1]) / 32);
      y++
    )
      for (
        let x = Math.floor(Math.min(a[0], b[0]) / 32);
        x <= Math.floor(Math.max(a[0], b[0]) / 32);
        x++
      ) {
        let column = bins.get(x);
        if (!column) bins.set(x, (column = new Map<number, number[]>()));
        let ids = column.get(y);
        if (!ids) column.set(y, (ids = []));
        ids.push(i - 1);
      }
  }
  const origin = event.route[0]!;
  const segments = line.points.slice(1).map((b, i) => {
    const a = line.points[i]!,
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    return { x: a[0], y: a[1], dx, dy, length: Math.hypot(dx, dy), along: line.along[i]! };
  });
  routes.set(
    event,
    (index = {
      frame,
      line,
      bins,
      origin,
      kx: frame.to([origin[0] + 1, origin[1]])[0],
      ky: frame.to([origin[0], origin[1] + 1])[1],
      visited: new Uint32Array(segments.length),
      epoch: 0,
      segments,
      nearest: { s: 0, off: 0, segment: -1, target: [0, 0], distance2: Infinity, x: 0, y: 0 },
    }),
  );
  return index;
}
function visitSegment(index: RouteIndex, i: number, x: number, y: number) {
  if (index.visited[i] === index.epoch) return;
  index.visited[i] = index.epoch;
  const a = index.segments[i]!;
  if (!a.length) return;
  const u = Math.max(0, Math.min(1, ((x - a.x) * a.dx + (y - a.y) * a.dy) / (a.length * a.length)));
  const px = a.x + u * a.dx,
    py = a.y + u * a.dy,
    distance2 = (x - px) ** 2 + (y - py) ** 2;
  const result = index.nearest;
  if (distance2 < result.distance2) {
    result.distance2 = distance2;
    result.s = a.along + u * a.length;
    result.off = ((y - py) * a.dx - (x - px) * a.dy) / a.length;
    result.segment = i;
    result.x = px;
    result.y = py;
  }
}
function nearest(index: RouteIndex, point: Point, geographicTarget = true) {
  const x = (point[0] - index.origin[0]) * index.kx,
    y = (point[1] - index.origin[1]) * index.ky;
  const bx = Math.floor(x / 32),
    by = Math.floor(y / 32);
  const result = index.nearest;
  result.distance2 = Infinity;
  result.segment = -1;
  result.s = result.off = 0;
  index.epoch = (index.epoch + 1) >>> 0;
  if (!index.epoch) {
    index.visited.fill(0);
    index.epoch = 1;
  }
  if (index.segments.length === 1) visitSegment(index, 0, x, y);
  else {
    for (let cx = bx - 1; cx <= bx + 1; cx++) {
      const column = index.bins.get(cx);
      if (!column) continue;
      for (let cy = by - 1; cy <= by + 1; cy++) {
        const ids = column.get(cy);
        if (ids) for (const i of ids) visitSegment(index, i, x, y);
      }
    }
    // The searched square bounds every unvisited segment; distant areas use an exact fallback.
    const edge = Math.min(
      x - (bx - 1) * 32,
      (bx + 2) * 32 - x,
      y - (by - 1) * 32,
      (by + 2) * 32 - y,
    );
    if (result.distance2 > edge * edge)
      for (let i = 0; i < index.segments.length; i++) visitSegment(index, i, x, y);
  }
  if (geographicTarget) {
    result.target[0] = index.origin[0] + result.x / index.kx;
    result.target[1] = index.origin[1] + result.y / index.ky;
  }
  return result;
}
/** Raster subcells must have their entire outline inside permissions and outside hard geometry. */
export function crowdMask(
  ground: EventGround,
  col: number,
  row: number,
  fromCell: (col: number, row: number) => Point,
  allows?: (col: number, row: number) => boolean,
) {
  return new CrowdMaskRaster(ground, fromCell).mask(col, row, allows);
}
type SubGuard = ((agent: VisibleAgent, col: number, row: number) => boolean) & {
  terrainKey?: object;
  hardTerrainKey?: object;
};
type StaticCell = {
  mask: Uint32Array;
  point: Point;
  seated: boolean;
  along: Float64Array;
  flags: Uint8Array;
  count: number;
};
type Cache = {
  scale?: readonly [number, number];
  fromCell?: GridPlacement['fromCell'];
  terrain?: object;
  hardTerrain?: object;
  raster: CrowdMaskRaster;
  seated?: CrowdMaskRaster;
  area?: CrowdMaskRaster;
  columns: Map<number, Map<number, StaticCell | null>>;
  size: number;
};
const caches = new WeakMap<EventGround, Cache[]>();
function cacheFor(
  ground: EventGround,
  event: ProcessionRoute,
  grid: GridPlacement,
  guard?: SubGuard,
) {
  let saved = caches.get(ground);
  if (!saved) caches.set(ground, (saved = []));
  const world = grid.world,
    fromCell = grid.fromCell!;
  const terrain = guard?.terrainKey ?? guard,
    hardTerrain = guard?.hardTerrainKey ?? guard;
  let cache = saved.find(
    (c) =>
      c.terrain === terrain &&
      c.hardTerrain === hardTerrain &&
      (world ? c.scale?.[0] === world[0] && c.scale[1] === world[1] : c.fromCell === fromCell),
  );
  if (cache) return cache;
  const raster = (g: EventGround) =>
    new CrowdMaskRaster(g, fromCell, grid.grid.originCol, grid.grid.originRow);
  cache = {
    ...(world ? { scale: [world[0], world[1]] as const } : { fromCell }),
    terrain,
    hardTerrain,
    raster: raster(ground),
    seated: ground.seated && raster(ground.seated),
    area:
      (event.kind === 'procession' || event.kind === 'parade') && event.crowd_grounds?.length
        ? raster({ regions: event.crowd_grounds, blocked: [] })
        : undefined,
    columns: new Map(),
    size: 0,
  };
  if (saved.length >= 4) saved.shift();
  saved.push(cache);
  return cache;
}
function classify(
  event: Exclude<ProcessionRoute, { kind: 'mass' | 'fluvial' }>,
  near: ReturnType<typeof nearest>,
  area: boolean,
  blockWidth: number,
) {
  const segment = event.segments[near.segment];
  if (!segment) return area ? 1 : 0;
  const half = segment.width_m / 2,
    side = near.off > 0 ? 'left' : 'right';
  const verge = Math.max(streetSidewalks(segment)[side], segment.verge_m?.[side] ?? 0);
  return (
    (area || (Math.abs(near.off) > half && Math.abs(near.off) <= half + verge) ? 1 : 0) |
    (Math.abs(near.off) <= half ? 2 : 0) |
    (Math.abs(near.off) < blockWidth ? 4 : 0)
  );
}
const densityScratch: [number, number] = [0, 0];
function movingDensity(
  event: ProcessionRoute,
  back: number,
  flags: number,
  layout: ReturnType<typeof formationLayout> | undefined,
  paint: number,
): [number, number] {
  let density = flags & 1 ? PROCESSION.throng.verge : 0;
  if (flags & 2) {
    if (event.kind === 'procession' && back >= -layout!.leading && back <= layout!.tail)
      density =
        back <= Math.min(300, layout!.tail) ? PROCESSION.throng.stream : PROCESSION.throng.tail;
    if (event.kind === 'parade' && flags & 4) {
      let lo = 0,
        hi = layout!.blocks.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (layout!.blocks[mid]!.back <= back) lo = mid + 1;
        else hi = mid;
      }
      const block = layout!.blocks[lo - 1];
      if (block && back <= block.back + block.length) {
        density = 0.98;
        paint = block.paint;
      }
    }
  }
  densityScratch[0] = density;
  densityScratch[1] = paint;
  return densityScratch;
}
export function throng(
  event: ProcessionRoute,
  progress: number,
  grid: GridPlacement,
  cols: number,
  rows: number,
  zoom: number,
  quality = 1,
  allowsSubcell?: SubGuard,
): ThrongPayload {
  const result: ThrongPayload = { cells: [], cap: Math.floor(MAX_THRONG_CELLS * quality) };
  const fromCell = grid.fromCell;
  if (!fromCell || zoom < 15 || progress < 0 || progress >= 1 || quality <= 0) return result;
  const ground = groundForRoute(event),
    bounds = eventGroundBounds(ground),
    corners = [grid.toCell(bounds[0], bounds[1]), grid.toCell(bounds[2], bounds[3])];
  const origin = grid.grid,
    centre = fromCell(cols / 2, rows / 2),
    frame = localMetricProjection(centre),
    east = frame.from([1, 0]),
    cp = grid.toCell(...centre),
    ep = grid.toCell(...east);
  const fit = figureFit('adult', Math.hypot(ep[0] - cp[0], ep[1] - cp[1]) * 0.6);
  const stride =
    zoom < 17
      ? 1
      : fit === 'big'
        ? 2
        : fit === 'stamp'
          ? Math.max(3, Math.ceil(Math.hypot(ep[0] - cp[0], ep[1] - cp[1]) * 0.7))
          : 1;
  const minC = Math.max(0, Math.floor(Math.min(...corners.map((q) => q[0]))) - stride),
    maxC = Math.min(cols, Math.ceil(Math.max(...corners.map((q) => q[0]))) + stride);
  const minR = Math.max(0, Math.floor(Math.min(...corners.map((q) => q[1]))) - stride),
    maxR = Math.min(rows, Math.ceil(Math.max(...corners.map((q) => q[1]))) + stride);
  const index = event.kind === 'mass' ? undefined : routeIndex(event),
    layout =
      event.kind === 'procession' || event.kind === 'parade' ? formationLayout(event) : undefined;
  const head = layout?.head(progress) ?? 0;
  const blockWidth = layout
    ? (((layout.blocks[0]?.columns ?? layout.columns) - 1) * PROCESSION_GEOMETRY.columnPitch) / 2 +
      PROCESSION_GEOMETRY.person.width / 2
    : 0;
  const cache = zoom < 17 ? cacheFor(ground, event, grid, allowsSubcell) : undefined;
  const areaGround: EventGround | undefined =
    event.kind === 'procession' || event.kind === 'parade'
      ? {
          regions: event.crowd_grounds ?? [],
          blocked: ground.blocked,
          water: ground.water,
          bridges: ground.bridges,
        }
      : undefined;
  const massFrame =
    event.kind === 'mass'
      ? localMetricProjection(event.site.altar?.at ?? event.site.location)
      : undefined;
  const massRamp =
    event.kind === 'mass'
      ? Math.min(
          1,
          progress / PROCESSION.mass.arrivalEnd,
          (1 - progress) / (1 - PROCESSION.mass.disperseStart),
        )
      : 1;
  const weights = new Float64Array(16);
  for (
    let row = minR + ((stride - ((minR + origin.originRow) % stride)) % stride);
    row < maxR;
    row += stride
  )
    for (
      let col = minC + ((stride - ((minC + origin.originCol) % stride)) % stride);
      col < maxC;
      col += stride
    ) {
      const ac = col + origin.originCol,
        ar = row + origin.originRow;
      const cached = cache?.columns.get(ac)?.get(ar);
      if (cached === null) continue;
      let point = cached?.point ?? fromCell(col + 0.5, row + 0.5);
      const hash = mix(col + origin.originCol, row + origin.originRow),
        share = (hash & 0xffff) / 65536;
      let density = 0,
        paint = 3 + (hash % 8),
        target = point,
        role: VisibleAgent['eventRole'];
      let mask: Uint32Array | undefined;
      let near: ReturnType<typeof nearest> | undefined;
      if (cache) {
        let cell: StaticCell | null | undefined = cached;
        if (cell === undefined) {
          const candidate: VisibleAgent = {
            kind: 'person',
            lng: point[0],
            lat: point[1],
            flap: 0,
            eventGround: event.id,
          };
          const guard =
            allowsSubcell &&
            ((c: number, r: number) =>
              allowsSubcell(candidate, c - origin.originCol * 16, r - origin.originRow * 16));
          let raster = cache.raster,
            seated = false;
          mask = raster.mask(ac, ar, guard);
          if (!mask && cache.seated) {
            candidate.eventRole = 'seated';
            seated = true;
            raster = cache.seated;
            mask = raster.mask(ac, ar, guard);
          }
          cell = null;
          if (mask) {
            const along = new Float64Array(256),
              flags = new Uint8Array(256);
            let count = 0,
              closest = Infinity;
            const representative: Point = [0, 0],
              sample: Point = [0, 0];
            for (let bit = 0; bit < 256; bit++)
              if ((mask[bit >>> 5]! >>> (bit & 31)) & 1) {
                raster.point(ac, ar, bit, sample);
                const distance = ((bit % 16) - 7.5) ** 2 + (Math.floor(bit / 16) - 7.5) ** 2;
                if (distance < closest) {
                  closest = distance;
                  representative[0] = sample[0];
                  representative[1] = sample[1];
                }
                if (event.kind === 'procession' || event.kind === 'parade') {
                  const at = nearest(index!, sample, false),
                    flag = classify(
                      event,
                      at,
                      cache.area?.hasPoint(ac, ar, bit) ?? false,
                      blockWidth,
                    );
                  along[count] = at.s;
                  flags[count] = flag;
                }
                count++;
              }
            cell = { mask, seated, point: representative, along, flags, count };
          }
          if (cache.size >= 16384) {
            const oldest = cache.columns.keys().next().value!;
            cache.size -= cache.columns.get(oldest)!.size;
            cache.columns.delete(oldest);
          }
          let column = cache.columns.get(ac);
          if (!column) cache.columns.set(ac, (column = new Map<number, StaticCell | null>()));
          column.set(ar, cell);
          cache.size++;
        }
        if (!cell) continue;
        point = cell.point;
        mask = cell.mask;
        if (cell.seated) role = 'seated';
        if (event.kind === 'procession' || event.kind === 'parade') {
          weights.fill(0);
          let sum = 0;
          for (let i = 0; i < cell.count; i++) {
            const [d, p] = movingDensity(
              event,
              head - cell.along[i]!,
              cell.flags[i]!,
              layout,
              paint,
            );
            sum += d;
            weights[p]! += d;
          }
          density = sum / cell.count;
          let best = 0;
          for (let p = 0; p < weights.length; p++)
            if (weights[p]! > best) {
              best = weights[p]!;
              paint = p;
            }
        }
      }

      if (event.kind === 'mass') {
        target = event.site.altar?.at ?? event.site.location;
        if (!cache) {
          if (ground.seated && eventGroundAllows(ground.seated, [point])) role = 'seated';
          if (!eventGroundAllows(role ? ground.seated! : ground, [point])) continue;
        }
        // Stable cells fill from the facing point and drain outside-in; disconnected areas survive.
        const distance = Math.hypot(...massFrame!.to(point));
        const outer = Math.max(1, event.site.radius_m);
        if (massRamp < 1 && distance / outer > massRamp) continue;
        density = PROCESSION.throng.mass;
      } else if (event.kind === 'fluvial') {
        density = PROCESSION.throng.bank;
        if (!cache) {
          near = nearest(index!, point);
          target = near.target;
        }
      } else if (!cache) {
        near = nearest(index!, point);
        target = near.target;
        [density, paint] = movingDensity(
          event,
          head - near.s,
          classify(event, near, !!areaGround && eventGroundAllows(areaGround, [point]), blockWidth),
          layout,
          paint,
        );
      }
      if (share >= density) continue;
      const agent: VisibleAgent = {
        kind: 'person',
        lng: point[0],
        lat: point[1],
        paint,
        flap: hash & 1,
        candle: (hash >>> 16) % 10 < 6,
        eventGround: event.id,
        ...(role && {
          eventRole: role,
          people: [{ figure: 'seated', paint, lateral: 0, back: 0, flap: 0 }],
        }),
      };
      if (zoom < 17) {
        agent.lng = fromCell(col + 0.5, row + 0.5)[0];
        agent.lat = fromCell(col + 0.5, row + 0.5)[1];
        agent.prop = 'event';
        agent.glyph = String.fromCharCode(ProcessionGlyph.crowd0.charCodeAt(0) + (hash % 4));
      } else {
        if (!eventGroundAllows(role ? ground.seated! : ground, [point])) continue;
        const local = localMetricProjection(point),
          to = local.to(target),
          d = Math.hypot(...to) || 1;
        const heading =
          near && (event.kind === 'procession' || event.kind === 'parade')
            ? index!.line.at(near.s)
            : { hx: to[0] / d, hy: to[1] / d };
        agent.ahead = local.from([heading.hx, heading.hy]);
        agent.side = local.from([heading.hy, -heading.hx]);
      }
      result.cells.push({ col, row, agent, mask, hash });
    }
  // Stable linear buckets spread cap thinning across the viewport without a full sort.
  const buckets: ThrongCell[][] = Array.from({ length: 256 }, () => []);
  for (const cell of result.cells) buckets[cell.hash >>> 24]!.push(cell);
  result.cells = buckets.flat();
  return result;
}

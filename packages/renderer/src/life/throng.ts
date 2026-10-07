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
import { CrowdMaskRaster, THRONG_MASK_SIDE, THRONG_MASK_BITS } from './crowd-mask';
export { THRONG_MASK_SIDE } from './crowd-mask';
import { formationLayout } from './formation-layout';
import { PROCESSION, routePolyline } from './procession';
import { ProcessionGlyph } from './procession-glyphs';
import { figureFit } from './people';
export const MAX_THRONG_CELLS = 16000;
/** At most this many 256-subcell classifications run in one animation frame. */
export const MAX_COLD_THRONG_CELLS = 8;
/** Detailed cells need one classification, rather than 256 subcell classifications. */
export const MAX_COLD_FINE_THRONG_CELLS = 128;
export type ThrongCell = {
  col: number;
  row: number;
  agent: VisibleAgent;
  mask?: Uint32Array;
  hash: number;
  stamp?: ThrongStampCache;
};
/** A world-anchored figure's ink; dynamic occupancy is checked when it is copied. */
export type ThrongStampCache = {
  theme?: object;
  glyphs?: object;
  cellWidth?: number;
  cellHeight?: number;
  paint?: number;
  cells?: Int32Array;
  bytes?: Uint8Array;
  /** Most street-level figures occupy one texel: avoid two tiny typed allocations each. */
  single?: readonly [number, number, number];
  terrain?: object;
  hardTerrain?: object;
  permitted?: boolean;
  complete?: boolean;
  viewport?: readonly [number, number, number, number];
};
export type ThrongPayload = {
  cells: ThrongCell[];
  cap: number;
  pending?: boolean;
  stampPending?: boolean;
};
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
type SubGuard = ((agent: VisibleAgent, col: number, row: number) => boolean) & {
  terrainKey?: object;
  hardTerrainKey?: object;
};
type StaticCell = {
  mask?: Uint32Array;
  point: Point;
  seated: boolean;
  along: Float64Array;
  flags: Uint8Array;
  count: number;
  ahead?: Point;
  side?: Point;
  stamp?: ThrongStampCache;
  agent?: VisibleAgent;
  cell?: ThrongCell;
  s?: number;
  flag?: number;
};
type Cache = {
  scale?: readonly [number, number];
  fromCell?: GridPlacement['fromCell'];
  terrain?: object;
  hardTerrain?: object;
  fine: boolean;
  raster: CrowdMaskRaster;
  seated?: CrowdMaskRaster;
  area?: CrowdMaskRaster;
  columns: Map<number, Map<number, StaticCell | null>>;
  size: number;
  viewport?: readonly [number, number, number, number];
  payload?: {
    col: number;
    row: number;
    cols: number;
    rows: number;
    progress: number;
    quality: number;
    result: ThrongPayload;
  };
};
const caches = new WeakMap<EventGround, Cache[]>();
const areaGrounds = new WeakMap<ProcessionRoute, EventGround>();
function areaFor(event: ProcessionRoute, ground: EventGround) {
  if (event.kind !== 'procession' && event.kind !== 'parade') return undefined;
  let area = areaGrounds.get(event);
  if (!area) {
    area = {
      regions: event.crowd_grounds ?? [],
      blocked: ground.blocked,
      water: ground.water,
      bridges: ground.bridges,
    };
    areaGrounds.set(event, area);
  }
  return area;
}
function cacheFor(
  ground: EventGround,
  event: ProcessionRoute,
  grid: GridPlacement,
  guard?: SubGuard,
  fine = false,
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
      c.fine === fine &&
      (world ? c.scale?.[0] === world[0] && c.scale[1] === world[1] : c.fromCell === fromCell),
  );
  if (cache) return cache;
  const raster = (g: EventGround) =>
    new CrowdMaskRaster(
      g,
      fromCell,
      grid.grid.originCol,
      grid.grid.originRow,
      fine ? 1 : undefined,
    );
  cache = {
    ...(world ? { scale: [world[0], world[1]] as const } : { fromCell }),
    terrain,
    hardTerrain,
    fine,
    raster: raster(ground),
    seated: ground.seated && raster(ground.seated),
    area:
      (event.kind === 'procession' || event.kind === 'parade') && event.crowd_grounds?.length
        ? raster(areaFor(event, ground)!)
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
const weights = new Float64Array(16);
const bucketCounts = new Uint32Array(256);
const bucketOffsets = new Uint32Array(256);
const sortedCells: ThrongCell[] = [];
const EMPTY_ALONG = new Float64Array(0),
  EMPTY_FLAGS = new Uint8Array(0);
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
        back <= Math.min(PROCESSION.throng.streamLength, layout!.tail)
          ? PROCESSION.throng.stream
          : PROCESSION.throng.tail;
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
  // Production placements expose a world scale, allowing detailed geometry to survive
  // fresh accepted worker frames and integer-cell pans. Legacy forward placements remain direct.
  const fine = zoom >= 17;
  const cache =
    !fine || grid.world ? cacheFor(ground, event, grid, allowsSubcell, fine) : undefined;
  const coldLimit = fine ? MAX_COLD_FINE_THRONG_CELLS : MAX_COLD_THRONG_CELLS;
  const areaGround = areaFor(event, ground);
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
  const progressKey = event.kind === 'mass' ? massRamp : event.kind === 'fluvial' ? 0 : head;
  const held = cache?.payload;
  if (
    held &&
    held.col === origin.originCol &&
    held.row === origin.originRow &&
    held.cols === cols &&
    held.rows === rows &&
    held.progress === progressKey &&
    held.quality === quality
  )
    return held.result;
  if (cache) {
    const viewport = [
      minC + origin.originCol,
      minR + origin.originRow,
      maxC + origin.originCol,
      maxR + origin.originRow,
    ] as const;
    if (!cache.viewport || viewport.some((value, i) => value !== cache.viewport![i])) {
      // Keep a small pan margin, rather than every world cell visited during a long replay.
      for (const [col, cells] of cache.columns) {
        if (col < viewport[0] - 32 || col >= viewport[2] + 32) {
          cache.size -= cells.size;
          cache.columns.delete(col);
        } else
          for (const row of cells.keys())
            if (row < viewport[1] - 32 || row >= viewport[3] + 32) {
              cells.delete(row);
              cache.size--;
            }
      }
      cache.viewport = viewport;
    }
  }
  let coldCells = 0;
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
      if (cache && cached === undefined && coldCells >= coldLimit) {
        result.pending = true;
        continue;
      }
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
        if (cell === undefined && fine) {
          coldCells++;
          const seated = !!cache.seated?.mask(ac, ar);
          cell = null;
          if (seated || cache.raster.mask(ac, ar)) {
            const at = index && nearest(index, point);
            const heading =
              at && (event.kind === 'procession' || event.kind === 'parade')
                ? index.line.at(at.s)
                : undefined;
            const local = localMetricProjection(point),
              to = local.to(
                event.kind === 'mass' ? (event.site.altar?.at ?? event.site.location) : at!.target,
              ),
              d = Math.hypot(...to) || 1;
            const hx = heading?.hx ?? to[0] / d,
              hy = heading?.hy ?? to[1] / d;
            cell = {
              seated,
              point,
              count: 1,
              along: EMPTY_ALONG,
              flags: EMPTY_FLAGS,
              s: at?.s ?? 0,
              flag:
                event.kind === 'procession' || event.kind === 'parade'
                  ? classify(event, at!, !!cache.area?.mask(ac, ar), blockWidth)
                  : 0,
              ahead: local.from([hx, hy]),
              side: local.from([hy, -hx]),
              stamp: {},
            };
          }
          let column = cache.columns.get(ac);
          if (!column) cache.columns.set(ac, (column = new Map<number, StaticCell | null>()));
          column.set(ar, cell);
          cache.size++;
        }
        if (cell === undefined) {
          const intersects = cache.raster.covers(ac, ar) || cache.seated?.covers(ac, ar);
          if (intersects) coldCells++;
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
              allowsSubcell(
                candidate,
                c - origin.originCol * THRONG_MASK_SIDE,
                r - origin.originRow * THRONG_MASK_SIDE,
              ));
          const raster = cache.raster;
          let seatedMask: Uint32Array | undefined;
          mask = intersects ? raster.mask(ac, ar, guard) : undefined;
          if (intersects && cache.seated) {
            candidate.eventRole = 'seated';
            seatedMask = cache.seated.mask(ac, ar, guard);
            if (seatedMask) {
              if (!mask) mask = seatedMask.slice();
              else for (let word = 0; word < mask.length; word++) mask[word]! |= seatedMask[word]!;
            }
          }
          cell = null;
          if (mask) {
            const along = new Float64Array(THRONG_MASK_BITS),
              flags = new Uint8Array(THRONG_MASK_BITS);
            let count = 0,
              closest = Infinity,
              seated = false;
            const representative: Point = [0, 0],
              sample: Point = [0, 0];
            for (let bit = 0; bit < THRONG_MASK_BITS; bit++)
              if ((mask[bit >>> 5]! >>> (bit & 31)) & 1) {
                raster.point(ac, ar, bit, sample);
                const middle = (THRONG_MASK_SIDE - 1) / 2;
                const distance =
                  ((bit % THRONG_MASK_SIDE) - middle) ** 2 +
                  (Math.floor(bit / THRONG_MASK_SIDE) - middle) ** 2;
                if (distance < closest) {
                  closest = distance;
                  representative[0] = sample[0];
                  representative[1] = sample[1];
                  seated = !!seatedMask && !!((seatedMask[bit >>> 5]! >>> (bit & 31)) & 1);
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
            // Never evict the current viewport while its bounded construction is unfinished.
            for (const [column, cells] of cache.columns)
              if (column < minC + origin.originCol || column >= maxC + origin.originCol) {
                cache.size -= cells.size;
                cache.columns.delete(column);
                break;
              }
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
              head - (cell.s ?? cell.along[i]!),
              cell.flag ?? cell.flags[i]!,
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
      const staticCell = fine ? cache?.columns.get(ac)?.get(ar) : undefined;
      const agent: VisibleAgent =
        staticCell?.agent?.paint === paint
          ? staticCell.agent
          : {
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
      if (staticCell) staticCell.agent = agent;
      if (zoom < 17) {
        const centre = fromCell(col + 0.5, row + 0.5);
        agent.lng = centre[0];
        agent.lat = centre[1];
        agent.prop = 'event';
        agent.glyph = String.fromCharCode(ProcessionGlyph.crowd0.charCodeAt(0) + (hash % 4));
      } else if (cache) {
        const cell = cache.columns.get(ac)!.get(ar)!;
        agent.ahead = cell.ahead;
        agent.side = cell.side;
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
      let candidate = staticCell?.cell;
      if (
        !candidate ||
        candidate.col !== col ||
        candidate.row !== row ||
        candidate.agent !== agent
      ) {
        candidate = { col, row, agent, mask, hash, stamp: staticCell?.stamp };
        if (staticCell) staticCell.cell = candidate;
      }
      result.cells.push(candidate);
    }
  // Stable linear buckets spread cap thinning across the viewport without a full sort.
  bucketCounts.fill(0);
  for (const cell of result.cells) bucketCounts[cell.hash >>> 24]!++;
  let offset = 0;
  for (let i = 0; i < bucketCounts.length; i++) {
    bucketOffsets[i] = offset;
    offset += bucketCounts[i]!;
  }
  for (const cell of result.cells) sortedCells[bucketOffsets[cell.hash >>> 24]!++] = cell;
  for (let i = 0; i < result.cells.length; i++) result.cells[i] = sortedCells[i]!;
  sortedCells.length = 0;
  if (cache && !result.pending)
    cache.payload = {
      col: origin.originCol,
      row: origin.originRow,
      cols,
      rows,
      progress: progressKey,
      quality,
      result,
    };
  return result;
}

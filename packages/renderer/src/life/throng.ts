/** Stateless crowd raster candidates. No population, owners, inspection or worker agents. */
import { localMetricProjection, type ProcessionRoute } from '@atlas/shared';
import type { GridPlacement } from '../grid';
import type { VisibleAgent } from './simulate';
import {
  eventGroundAllows,
  eventGroundTouches,
  eventGroundBounds,
  groundForRoute,
  type EventGround,
} from './ground-events';
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
  bins: Map<string, number[]>;
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
    bins = new Map<string, number[]>();
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
        const key = `${x}/${y}`;
        let ids = bins.get(key);
        if (!ids) bins.set(key, (ids = []));
        ids.push(i - 1);
      }
  }
  routes.set(event, (index = { frame, line, bins }));
  return index;
}
function nearest(index: RouteIndex, point: Point) {
  const q = index.frame.to(point),
    bx = Math.floor(q[0] / 32),
    by = Math.floor(q[1] / 32);
  let best = Infinity,
    s = 0,
    off = 0,
    segment = 0,
    target: Point = point;
  for (let y = by - 2; y <= by + 2; y++)
    for (let x = bx - 2; x <= bx + 2; x++)
      for (const i of index.bins.get(`${x}/${y}`) ?? []) {
        const a = index.line.points[i]!,
          b = index.line.points[i + 1]!,
          dx = b[0] - a[0],
          dy = b[1] - a[1],
          d = dx * dx + dy * dy;
        if (!d) continue;
        const u = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / d)),
          px = a[0] + u * dx,
          py = a[1] + u * dy,
          distance = (q[0] - px) ** 2 + (q[1] - py) ** 2;
        if (distance < best) {
          best = distance;
          s = index.line.along[i]! + u * Math.sqrt(d);
          off = ((q[1] - py) * dx - (q[0] - px) * dy) / Math.sqrt(d);
          segment = i;
          target = index.frame.from([px, py]);
        }
      }
  return { s, off, segment, target, distance: Math.sqrt(best) };
}
/** Raster subcells must have their entire outline inside permissions and outside hard geometry. */
export function crowdMask(
  ground: EventGround,
  col: number,
  row: number,
  fromCell: (col: number, row: number) => Point,
  allows?: (col: number, row: number) => boolean,
) {
  const words = new Uint32Array(8);
  let filled = false;
  for (let y = 0; y < THRONG_MASK_SIDE; y++)
    for (let x = 0; x < THRONG_MASK_SIDE; x++) {
      const c = col + x / THRONG_MASK_SIDE,
        r = row + y / THRONG_MASK_SIDE,
        h = 1 / THRONG_MASK_SIDE;
      const outline = [
        fromCell(c, r),
        fromCell(c + h, r),
        fromCell(c + h, r + h),
        fromCell(c, r + h),
      ];
      if (
        !eventGroundAllows(ground, [fromCell(c + h / 2, r + h / 2), ...outline], outline) ||
        (allows && !allows(col * THRONG_MASK_SIDE + x, row * THRONG_MASK_SIDE + y))
      )
        continue;
      const bit = y * THRONG_MASK_SIDE + x;
      words[bit >>> 5]! |= (1 << (bit & 31)) >>> 0;
      filled = true;
    }
  return filled ? words : undefined;
}
export function throng(
  event: ProcessionRoute,
  progress: number,
  grid: GridPlacement,
  cols: number,
  rows: number,
  zoom: number,
  quality = 1,
  allowsSubcell?: (agent: VisibleAgent, col: number, row: number) => boolean,
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
      let point = fromCell(col + 0.5, row + 0.5);
      const hash = mix(col + origin.originCol, row + origin.originRow),
        share = (hash & 0xffff) / 65536;
      let density = 0,
        paint = 3 + (hash % 8),
        target = point,
        role: VisibleAgent['eventRole'];
      let mask: Uint32Array | undefined;
      if (zoom < 17) {
        const outline = [
          fromCell(col, row),
          fromCell(col + 1, row),
          fromCell(col + 1, row + 1),
          fromCell(col, row + 1),
        ];
        const candidate: VisibleAgent = {
          kind: 'person',
          lng: point[0],
          lat: point[1],
          flap: 0,
          eventGround: event.id,
        };
        if (eventGroundTouches(ground, outline))
          mask = crowdMask(
            ground,
            col,
            row,
            fromCell,
            allowsSubcell && ((c, r) => allowsSubcell(candidate, c, r)),
          );
        if (!mask && ground.seated && eventGroundTouches(ground.seated, outline)) {
          candidate.eventRole = 'seated';
          role = 'seated';
          mask = crowdMask(
            ground.seated,
            col,
            row,
            fromCell,
            allowsSubcell && ((c, r) => allowsSubcell(candidate, c, r)),
          );
        }
        if (!mask) continue;
        const word = mask.findIndex((w) => w !== 0),
          value = mask[word]!;
        const bit = word * 32 + 31 - Math.clz32(value & -value);
        point = fromCell(col + ((bit % 16) + 0.5) / 16, row + (Math.floor(bit / 16) + 0.5) / 16);
      }

      if (event.kind === 'mass') {
        target = event.site.altar?.at ?? event.site.location;
        const seated =
          role === 'seated' || (ground.seated && eventGroundAllows(ground.seated, [point]));
        const permission = seated ? ground.seated! : ground;
        if (!eventGroundAllows(permission, [point])) continue;
        if (seated) role = 'seated';
        // Stable cells fill from the facing point and drain outside-in; disconnected areas survive.
        const distance = Math.hypot(...massFrame!.to(point));
        const outer = Math.max(1, event.site.radius_m);
        if (massRamp < 1 && distance / outer > massRamp) continue;
        density = PROCESSION.throng.mass;
      } else {
        const near = nearest(index!, point);
        target = near.target;
        if (event.kind === 'fluvial') density = PROCESSION.throng.bank;
        else {
          const segment = event.segments[near.segment]!;
          if (!segment) continue;
          const half = segment.width_m / 2,
            side = near.off > 0 ? 'left' : 'right',
            verge = segment.verge_m?.[side] ?? segment.sidewalks_m?.[side] ?? segment.sidewalk_m;
          if (Math.abs(near.off) > half && Math.abs(near.off) <= half + verge)
            density = PROCESSION.throng.verge;
          if (areaGround && eventGroundAllows(areaGround, [point]))
            density = PROCESSION.throng.verge;
          const back = head - near.s;
          if (Math.abs(near.off) <= half) {
            if (event.kind === 'procession' && back >= -60 && back <= 500)
              density = back <= 300 ? PROCESSION.throng.stream : PROCESSION.throng.tail;
            if (event.kind === 'parade') {
              let lo = 0,
                hi = layout!.blocks.length;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (layout!.blocks[mid]!.back <= back) lo = mid + 1;
                else hi = mid;
              }
              const block = layout!.blocks[lo - 1];
              if (
                block &&
                back <= block.back + block.length &&
                Math.abs(near.off) < (block.columns - 1) * 0.4 + 0.5
              ) {
                density = 0.98;
                paint = block.paint;
              }
            }
          }
        }
      }
      if (share >= density) continue;
      const local = localMetricProjection(point),
        to = local.to(target),
        d = Math.hypot(...to) || 1,
        heading: [number, number] =
          event.kind === 'parade' || event.kind === 'procession'
            ? (() => {
                const at = index!.line.at(nearest(index!, point).s);
                return [at.hx, at.hy];
              })()
            : [to[0] / d, to[1] / d];
      const agent: VisibleAgent = {
        kind: 'person',
        lng: point[0],
        lat: point[1],
        ahead: local.from(heading),
        side: local.from([heading[1], -heading[0]]),
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
      } else if (!eventGroundAllows(role ? ground.seated! : ground, [point])) continue;
      result.cells.push({ col, row, agent, mask, hash });
    }
  // Stable linear buckets spread cap thinning across the viewport without a full sort.
  const buckets: ThrongCell[][] = Array.from({ length: 256 }, () => []);
  for (const cell of result.cells) buckets[cell.hash >>> 24]!.push(cell);
  result.cells = buckets.flat();
  return result;
}

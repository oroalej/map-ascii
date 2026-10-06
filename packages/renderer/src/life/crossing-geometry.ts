import type { ControlledCrossingAnchor, CrossingSide } from './geometry';
import {
  bodyInside,
  bodiesOverlap,
  memberSize,
  boundsOf,
  PolygonIndex,
  type Body,
  type Point,
  type Polygon,
} from './occupancy';
import { RoadAccess, subtractCrossing } from './terrain';

/** Built after every carriageway has arrived; all stored positions remain tile-local. */
export function finalizeControlledCrossings(
  anchors: readonly ControlledCrossingAnchor[],
  roads: readonly Polygon[],
  perMeter: number,
  access = RoadAccess.fromPrepared(roads, []),
): void {
  const roadBounds = roads.map((road) => ({ road, bounds: boundsOf(road[0]!) }));
  const probe: Body = { x: 0, y: 0, hx: 1, hy: 0, length: 0, width: 0 },
    probes = [probe];
  const inRoad = (p: Point) => {
    probe.x = p.x;
    probe.y = p.y;
    return access.roads.hits(probes);
  };
  for (const crossing of anchors) {
    const theta = (crossing.bearing * Math.PI) / 180;
    const across = { x: Math.cos(theta), y: Math.sin(theta) };
    const lateral = { x: Math.sin(theta), y: -Math.cos(theta) };
    const at = (side: number, depth: number, offset: number): Point => ({
      x: crossing.anchor.x + (across.x * side * depth + lateral.x * offset) * perMeter,
      y: crossing.anchor.y + (across.y * side * depth + lateral.y * offset) * perMeter,
    });
    const sides = [-1, 1].map((side): CrossingSide => {
      let depth = crossing.width / 2;
      if (inRoad(crossing.anchor)) {
        let inside = 0,
          outside = 0.1;
        while (outside < crossing.width + 64 && inRoad(at(side, outside, 0))) {
          inside = outside;
          outside += 0.1;
        }
        for (let i = 0; i < 24; i++) {
          const mid = (inside + outside) / 2;
          if (inRoad(at(side, mid, 0))) inside = mid;
          else outside = mid;
        }
        depth = outside;
      }
      const gate: [Point, Point] = [at(side, depth, -1.5), at(side, depth, 1.5)];
      let pads = [
        [
          at(side, depth, -1.5),
          at(side, depth + 2, -1.5),
          at(side, depth + 2, 1.5),
          at(side, depth, 1.5),
          at(side, depth, -1.5),
        ],
      ];
      const [x0, y0, x1, y1] = boundsOf(pads[0]!);
      for (const {
        road,
        bounds: [a0, b0, a1, b1],
      } of roadBounds)
        if (a0 <= x1 && x0 <= a1 && b0 <= y1 && y0 <= b1)
          pads = pads.flatMap((pad) => subtractCrossing(pad, road[0]!));
      pads = pads.filter(
        (pad) =>
          Math.max(
            ...pad.map(
              (p) =>
                (((p.x - crossing.anchor.x) * across.x + (p.y - crossing.anchor.y) * across.y) *
                  side) /
                  perMeter -
                depth,
            ),
          ) >=
          1 - 1e-6,
      );
      const inward = { x: -side * across.x, y: -side * across.y };
      const size = memberSize('adult');
      // A tiny numerical margin keeps rotated slots from losing capacity at exact contact.
      const spacing = { depth: size.length + 0.1501, lateral: size.width + 0.1501 };
      const accepted: Body[] = [],
        slots: Point[] = [],
        slotIds: number[] = [];
      for (let row = 0; row < 2; row++)
        for (let column = 0; column < 2; column++) {
          const centre = at(
            side,
            depth + (2 - spacing.depth) / 2 + row * spacing.depth,
            (column - 0.5) * spacing.lateral,
          );
          const body = {
            ...centre,
            hx: inward.x,
            hy: inward.y,
            length: size.length * perMeter,
            width: size.width * perMeter,
          };
          if (
            !pads.some((pad) => bodyInside(body, [pad])) ||
            !access.allows([body], false) ||
            accepted.some((other) => bodiesOverlap(body, other, 0.15 * perMeter))
          )
            continue;
          accepted.push(body);
          slots.push(centre);
          slotIds.push(row * 2 + column);
        }
      return { gate, inward, centre: at(side, depth, 0), pads, slots, slotIds };
    }) as [CrossingSide, CrossingSide];
    crossing.sides = sides;
    crossing.quad = [
      sides[0].gate[0],
      sides[1].gate[0],
      sides[1].gate[1],
      sides[0].gate[1],
      sides[0].gate[0],
    ];
  }
}

/** Attach original crossing ends, preserving their two-point reach and mapped populations. */
export function controlledCrossingConnectors(
  anchors: readonly ControlledCrossingAnchor[],
  lines: readonly { line: number; id: number; navigationOnly: boolean; points: Point[] }[],
  roads: readonly Polygon[],
  cuts: readonly Polygon[],
  obstacles: readonly Polygon[],
  perMeter: number,
  identify: (id: string) => number,
  access = new RoadAccess(roads, cuts),
) {
  const blocked = new PolygonIndex();
  for (const polygon of obstacles) blocked.add(polygon);
  const joins = new Map<number, { segment: number; t: number; point: Point }[]>(),
    connectors: { points: Point[]; id: number }[] = [];
  const ids = new Set(anchors.map((c) => c.lineId));
  const walkingBounds = lines
    .filter((line) => !ids.has(line.id) && !line.navigationOnly)
    .map((line) => ({ line, bounds: boundsOf(line.points) }));
  const reach = 4 * perMeter;
  for (const crossing of anchors) {
    const crossingLine = lines.find((line) => line.id === crossing.lineId);
    if (!crossingLine) continue;
    for (const [side, p] of [crossingLine.points[0]!, crossingLine.points.at(-1)!].entries()) {
      if (
        lines.some(
          (line) =>
            line !== crossingLine &&
            !line.navigationOnly &&
            [line.points[0]!, line.points.at(-1)!].some(
              (q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.01 * perMeter,
            ),
        )
      )
        continue;
      const candidates = walkingBounds
        .filter(
          ({ bounds: [x0, y0, x1, y1] }) =>
            x0 <= p.x + reach && x1 >= p.x - reach && y0 <= p.y + reach && y1 >= p.y - reach,
        )
        .flatMap(({ line }) =>
          line.points.slice(1).map((b, segment) => {
            const a = line.points[segment]!,
              dx = b.x - a.x,
              dy = b.y - a.y;
            const t = Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
            );
            const point = { x: a.x + t * dx, y: a.y + t * dy },
              distance = Math.hypot(point.x - p.x, point.y - p.y);
            return { line: line.line, segment, t, point, distance };
          }),
        )
        .filter((candidate) => candidate.distance <= reach)
        .sort((a, b) => a.distance - b.distance || a.line - b.line || a.segment - b.segment);
      for (const candidate of candidates) {
        const steps = Math.max(1, Math.ceil(candidate.distance / (0.25 * perMeter)));
        const hx = candidate.distance
          ? (candidate.point.x - p.x) / candidate.distance
          : crossing.sides![side]!.inward.x;
        const hy = candidate.distance
          ? (candidate.point.y - p.y) / candidate.distance
          : crossing.sides![side]!.inward.y;
        let clear = true;
        for (let i = 0; i <= steps; i++) {
          const body = {
            x: p.x + ((candidate.point.x - p.x) * i) / steps,
            y: p.y + ((candidate.point.y - p.y) * i) / steps,
            hx,
            hy,
            length: 0.9 * perMeter,
            width: perMeter,
          };
          if (!access.allows([body]) || blocked.hits([body])) {
            clear = false;
            break;
          }
        }
        if (!clear) continue;
        const entries = joins.get(candidate.line) ?? [];
        if (
          !entries.some(
            (entry) =>
              Math.hypot(entry.point.x - candidate.point.x, entry.point.y - candidate.point.y) <
              0.01,
          )
        )
          entries.push(candidate);
        joins.set(candidate.line, entries);
        if (candidate.distance > 0.01 * perMeter)
          connectors.push({
            points: [p, candidate.point],
            id: identify(`${crossing.id}/connector/${side}`),
          });
        break;
      }
    }
  }
  return { joins, connectors };
}

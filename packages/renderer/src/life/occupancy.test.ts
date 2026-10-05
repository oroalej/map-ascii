import { describe, expect, it } from 'vitest';
import { pedestrianView } from './pedestrians';
import {
  bodiesOverlap,
  bodyCorners,
  corridorDistance,
  type Point,
  bodyInside,
  bodyHitsPolygon,
  Occupancy,
  BODY_KIND,
  PolygonIndex,
  type Body,
  type Polygon,
} from './occupancy';

const box = (x: number, y: number, length = 4, width = 2): Body => ({
  x,
  y,
  length,
  width,
  hx: 1,
  hy: 0,
});
const nearest = (o: Occupancy, x = 0, y = 0, hx = 1, hy = 0, width = 1, range = 10) =>
  pedestrianView(o, 0.9).walkersAlong(
    [{ x, y, hx, hy, length: range, ahead: 0, line: 0 }],
    width,
    range,
  );

describe('pedestrian occupancy queries', () => {
  const human = (x: number, y: number): Body => ({ ...box(x, y, 1, 1), kind: BODY_KIND.human });
  it('uses the intersected footprint, with side, behind, range and kind filtering', () => {
    const o = new Occupancy();
    for (const b of [human(-1, 0), human(4, 2), human(10.6, 0), box(2, 0)]) o.set({}, [b]);
    expect(nearest(o)).toBe(Infinity);
    const person = {};
    o.set(person, [human(10.4, 0)]);
    expect(nearest(o)).toBeCloseTo(9.9);
    o.set(person, [human(5, 0)]);
    expect(nearest(o)).toBe(4.5);
    o.delete(person);
    expect(nearest(o)).toBe(Infinity);
  });
  it('clips a rotated body and corridor across spatial bins', () => {
    const o = new Occupancy(),
      h = Math.SQRT1_2;
    o.set({}, [{ ...human(12 * h, 12 * h), hx: h, hy: h }]);
    expect(nearest(o, 0, 0, h, h, 1, 15)).toBeCloseTo(11.5);
    const rotated = new Occupancy();
    rotated.set({}, [{ ...human(5, 1), hx: h, hy: h, length: 4 }]);
    expect(nearest(rotated)).toBeGreaterThan(3);
    expect(nearest(rotated)).toBeLessThan(4);
  });
  it('visits area footprints with heading predicates and releases scratch references', () => {
    const o = new Occupancy(),
      person = {};
    const area = [ring(4, -1, 2, 2)];
    o.set(person, [human(5, 0)]);
    expect(o.someInArea(area, BODY_KIND.human, (b) => b.hx > 0)).toBe(true);
    expect(o.someInArea(area, BODY_KIND.animal)).toBe(false);
    expect(o.someInArea(area, BODY_KIND.human, undefined, person)).toBe(false);
    expect(o.someInArea([ring(20, 20, 2, 2)], BODY_KIND.human)).toBe(false);
    const scratch = o as unknown as { queryNeighbors: Set<object> };
    expect(scratch.queryNeighbors.size).toBe(0);
    nearest(o);
    expect(scratch.queryNeighbors.size).toBe(0);
    expect(() =>
      o.someInArea(area, BODY_KIND.human, () => {
        throw new Error('predicate');
      }),
    ).toThrow('predicate');
    expect(scratch.queryNeighbors.size).toBe(0);
    o.set(person, [{ ...human(5, 0), kind: BODY_KIND.animal }]);
    expect(nearest(o)).toBe(Infinity);
  });
  it('matches replacement updates for scores, classification and removal within shared bins', () => {
    const current = new Occupancy(),
      replaced = new Occupancy();
    const owners = Array.from({ length: 12 }, () => ({}));
    const bodies = owners.map((_, i) => human(4 + i * 0.1, 4));
    for (let i = 0; i < owners.length; i++) {
      current.set(owners[i]!, [bodies[i]!]);
      replaced.set(owners[i]!, [bodies[i]!]);
    }
    for (let frame = 0; frame < 60; frame++) {
      const index = frame % owners.length,
        owner = owners[index]!,
        body = bodies[index]!;
      body.x = 4 + index * 0.1 + Math.sin(frame) * 0.1;
      body.kind = frame % 3 ? BODY_KIND.vehicle : BODY_KIND.human;
      current.set(owner, [body]);
      replaced.delete(owner);
      replaced.set(owner, [body]);
      for (let i = 0; i < owners.length; i++)
        expect(current.conflicts(owners[i]!, [bodies[i]!])).toBe(
          replaced.conflicts(owners[i]!, [bodies[i]!]),
        );
      expect(current.hasHumans).toBe(replaced.hasHumans);
      expect(nearest(current, 0, 4)).toBe(nearest(replaced, 0, 4));
    }
    for (const owner of owners) current.delete(owner);
    expect(current.hasHumans).toBe(false);
    expect(nearest(current, 0, 4)).toBe(Infinity);
  });
});
const ring = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];

describe('ground footprints', () => {
  it('matches exhaustive tests around a concave polygon with a hole', () => {
    const polygons: Polygon[] = [
      [
        [
          { x: -20, y: -20 },
          { x: 20, y: -20 },
          { x: 20, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 20 },
          { x: -20, y: 20 },
          { x: -20, y: -20 },
        ],
        ring(-15, -15, 8, 8),
      ],
      [ring(40, 40, 6, 6)],
    ];
    const index = new PolygonIndex();
    polygons.forEach((p) => index.add(p));
    let seed = 123;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 2000; i++) {
      const heading = random() * Math.PI * 2;
      const body = {
        ...box(random() * 100 - 40, random() * 100 - 40, random() * 12, random() * 8),
        hx: Math.cos(heading),
        hy: Math.sin(heading),
      };
      expect(index.hits([body])).toBe(polygons.some((p) => bodyHitsPolygon(body, p)));
    }
  });
  it('retains near-touch tolerance and queries padded bounds across bins', () => {
    const polygon = [ring(1, 1, 10, 10)];
    const index = new PolygonIndex();
    index.add(polygon);
    const body = box(12 + 1e-7, 5, 2, 2);
    expect(bodyHitsPolygon(body, polygon)).toBe(true);
    expect(index.hits([body])).toBe(true);
    expect(index.near(11, 3, 12, 4)).toBe(true);
    expect(index.near(24, 3, 25, 4)).toBe(false);
    const seam = new PolygonIndex();
    seam.add([ring(12, 1, 1, 1)]);
    expect(seam.near(11.999, 1, 11.999, 2)).toBe(true);
  });
  it('checks rotated vehicles, including their ends rather than only centers', () => {
    expect(bodiesOverlap(box(0, 0), box(3, 0))).toBe(true);
    expect(bodiesOverlap(box(0, 0), box(0, 3))).toBe(false);
    expect(bodiesOverlap(box(0, 0), { ...box(2, 2), hx: Math.SQRT1_2, hy: Math.SQRT1_2 })).toBe(
      true,
    );
  });
  it('rejects a car whose center fits but whose body crosses the lot edge', () => {
    const lot = [ring(0, 0, 10, 10)];
    expect(bodyInside(box(5, 5), lot)).toBe(true);
    expect(bodyInside(box(1, 5), lot)).toBe(false);
  });
  it('rejects holes contained by a body, even when every corner is in the lot', () => {
    const lot = [ring(0, 0, 10, 10), ring(4.8, 4.8, 0.4, 0.4)];
    expect(bodyInside(box(5, 5), lot)).toBe(false);
    expect(bodyHitsPolygon(box(5, 5, 0.1, 0.1), lot)).toBe(false);
  });
  it('indexes moving bodies and removes their old reservation', () => {
    const occupied = new Occupancy(),
      me = {},
      other = {};
    occupied.set(other, [box(0, 0)]);
    expect(occupied.conflicts(me, [box(1, 0)])).toBeGreaterThan(0);
    expect(occupied.conflicts(other, [box(0, 0)])).toBe(0);
    occupied.set(other, [box(30, 30)]);
    expect(occupied.conflicts(me, [box(1, 0)])).toBe(0);
  });
  it('checks polygon boundaries across spatial bins without filling courtyards', () => {
    const terrain = new PolygonIndex();
    terrain.add([ring(-20, -20, 40, 40), ring(-5, -5, 10, 10)]);
    expect(terrain.hits([box(0, 0)])).toBe(false);
    expect(terrain.hits([box(12, 0)])).toBe(true);
    expect(terrain.hits([box(50, 0)])).toBe(false);
  });
});

function clippedReference(
  b: Body,
  x: number,
  y: number,
  hx: number,
  hy: number,
  halfWidth: number,
  range: number,
) {
  let points = bodyCorners(b).map((p) => ({
    x: (p.x - x) * hx + (p.y - y) * hy,
    y: -(p.x - x) * hy + (p.y - y) * hx,
  }));
  for (const [axis, bound, sign] of [
    [0, 0, 1],
    [0, range, -1],
    [1, -halfWidth, 1],
    [1, halfWidth, -1],
  ]) {
    const next: Point[] = [];
    const room = (p: Point) => ((axis === 0 ? p.x : p.y) - bound!) * sign!;
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!,
        c = points[(i + 1) % points.length]!;
      const da = room(a),
        dc = room(c);
      if (da >= -1e-9) next.push(a);
      if (da < 0 !== dc < 0) {
        const t = da / (da - dc);
        next.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t });
      }
    }
    points = next;
    if (!points.length) return Infinity;
  }
  let distance = Infinity;
  for (const p of points) distance = Math.min(distance, Math.max(0, p.x));
  return distance;
}

it('matches polygon clipping for seeded rotated footprints and zero-width/range corridors', () => {
  let seed = 90210;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 1500; i++) {
    const angle = random() * Math.PI * 2,
      direction = random() * Math.PI * 2;
    const body = {
      ...box(random() * 40 - 20, random() * 40 - 20, random() * 8, random() * 8),
      hx: Math.cos(angle),
      hy: Math.sin(angle),
    };
    const x = random() * 4 - 2,
      y = random() * 4 - 2,
      hx = Math.cos(direction),
      hy = Math.sin(direction);
    const width = i % 10 ? random() * 3 : 0,
      range = i % 7 ? random() * 20 : 0;
    const expected = clippedReference(body, x, y, hx, hy, width, range);
    const actual = corridorDistance(body, x, y, hx, hy, width, range);
    if (Number.isFinite(expected)) expect(actual).toBeCloseTo(expected, 8);
    else expect(actual).toBe(Infinity);
    const occupied = new Occupancy();
    occupied.set({}, [{ ...body, kind: BODY_KIND.human }]);
    const indexed = nearest(occupied, x, y, hx, hy, width, range);
    if (Number.isFinite(expected)) expect(indexed).toBeCloseTo(expected, 8);
    else expect(indexed).toBe(Infinity);
  }
});

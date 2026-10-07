import { expect, it } from 'vitest';
import { encodeEmergency } from '@atlas/shared';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife, type Mover } from './simulate';
import { hashString } from './random';
import { left } from './testing/continuity';
import { metersPerUnit, tileToLngLat, lngLatToTile } from '../raster/geometry';
import { EmergencyRouter } from './emergency-network';

it.each([1, -1] as const)(
  'stops on the selected interior polyline in direction %s without passing it',
  (dir) => {
    const pm = 1 / metersPerUnit(left),
      b = new LifeBuilder();
    const points = [
      { x: 1000, y: 1000 },
      { x: 1000 + 100 * pm, y: 1000 },
      { x: 1000 + 100 * pm, y: 1000 + 100 * pm },
      { x: 1000 + 200 * pm, y: 1000 + 100 * pm },
    ];
    b.line(points, LifeLine.roadMajor, 12, hashString('road'), dir);
    const life = new TileLife(left, b.finish(), 123),
      shape = points.map((p) => tileToLngLat(left, p));
    const at = tileToLngLat(left, { x: points[1]!.x, y: 1000 + 50 * pm });
    life.emergencyRouter = new EmergencyRouter(
      encodeEmergency({
        nodes: [shape[0]!, shape[3]!],
        edges: [{ from: 0, to: 1, length: 300, bearing: [0, 0], oneway: dir, shape }],
        targets: [
          {
            id: 'hospital',
            kind: 'hospital',
            at,
            edge: 0,
            t: 0.5,
            side: 1,
            road: 'road',
            tangent: [0, -1],
          },
        ],
        source: 'fixture',
      }),
    );
    const m: Mover = {
      kind: 'vehicle',
      vehicle: 'ambulance',
      line: 0,
      from: dir === 1 ? 1 : 2,
      dir,
      d: 20 * pm,
      speed: 5 * pm,
      v: 0,
      paint: 11,
      lane: 0,
      pause: 0,
      rank: 0,
      x: points[1]!.x,
      y: 1000 + (dir === 1 ? 20 : 80) * pm,
      hx: 0,
      hy: dir,
      routing: { seed: 123, turns: 0 },
      emergency: {
        id: 'ambulance/1',
        kind: 'ambulance',
        phase: 'responding',
        lights: true,
        target: 'hospital',
        baseSpeedMps: 5,
        remaining: 0,
        offscreen: 0,
        run: 1,
      },
    };
    life.movers.splice(0, life.movers.length, m);
    const targetY = lngLatToTile(left, ...life.emergencyRouter.targets.get('hospital')!.at).y;
    for (let i = 0; i < 400; i++) {
      life.step(
        1 / 30,
        () => true,
        (kind) => kind === 'vehicle',
        undefined,
        { rain: 0 },
      );
      expect((m.y - targetY) * dir).toBeLessThanOrEqual(1e-7);
    }
    expect(life.emergencyArrival(m)?.remaining).toBeLessThan(0.3);
    expect(m.v).toBeLessThan(0.1 * pm);
  },
);

import { expect, it } from 'vitest';
import { LifeWorld, type Mover } from './simulate';
import { LifeLine } from './geometry';
import { continuityMover, continuityTile, left } from './testing/continuity';
import { worldTiles } from './testing/scenarios';
import { tileToLngLat } from '../raster/geometry';

it.each([
  { yaw: 0, mode: 'ordinary' },
  { yaw: -0.3, mode: 'ordinary' },
  { yaw: 0.3, mode: 'ordinary' },
  { yaw: 0.3, mode: 'scene' },
  { yaw: 0.3, mode: 'turning' },
])(
  'keeps drawn member centres on their physical bodies while steering $yaw ($mode)',
  ({ yaw, mode }) => {
    const world = new LifeWorld();
    const entry = continuityTile(left, LifeLine.path);
    world.sync([entry]);
    const life = worldTiles(world).get(entry.key)!;
    const m: Mover = {
      ...continuityMover(life, 600, 'person'),
      roadYaw: yaw,
      momentFacing: mode === 'scene' ? { hx: 0, hy: 1 } : undefined,
      turning: mode === 'turning' ? { hx: -1, hy: 0, left: 0.2 } : undefined,
      avoid: -1.1,
      walked: 12,
      group: [
        { figure: 'adult', shirt: 2, canopy: 3, umbrella: 0.4, lateral: 0, back: 0, step: 1 },
        { figure: 'adult', shirt: 14, canopy: 2, umbrella: 0.9, lateral: -1, back: 0, step: 1 },
        { figure: 'child', shirt: 4, canopy: 10, umbrella: 0.6, lateral: 0, back: -1, step: 1 },
      ],
    };
    life.movers.splice(0, life.movers.length, m);
    life.gatherers.length = life.stalls.length = life.parked.length = 0;
    const members = m.group!;
    members.forEach(Object.freeze);
    const before = structuredClone(m),
      physical = life.groundBodies(m),
      pose = life.pose(m);
    const centre = tileToLngLat(entry.tile, pose);
    for (const zoom of [17, 19]) {
      const agent = world
        .visible(zoom, 1, centre, { rain: 0, sunAltitude: 40 })
        .find((v) => v.people?.length === 3)!;
      expect(agent).toBeDefined();
      expect([agent.lng, agent.lat]).toEqual(centre);
      expect(agent.mappedPersonMover).toBe(true);
      agent.people!.forEach((look, i) => {
        const x = pose.x / life.perMeter - pose.hy * look.lateral - pose.hx * look.back;
        const y = pose.y / life.perMeter + pose.hx * look.lateral - pose.hy * look.back;
        expect(x).toBeCloseTo(physical[i]!.x, 8);
        expect(y).toBeCloseTo(physical[i]!.y, 8);
        expect(look.paint).toBe(members[i]!.shirt);
        expect(look.figure).toBe(members[i]!.figure);
      });
    }
    expect(m).toEqual(before);
    expect(m.group).toBe(members);
  },
);

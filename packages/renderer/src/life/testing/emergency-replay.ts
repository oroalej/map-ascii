import { encodeEmergency, type EmergencyConfig } from '@atlas/shared';
import { LifeBuilder, LifeLine } from '../geometry';
import { LifeWorld, type TileLife } from '../simulate';
import { left } from './continuity';
import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { hashString } from '../random';
import { completeScenarioState, worldTiles } from './scenarios';
import { emergencyConfig } from './emergency';

export function dispatchFixture(config: EmergencyConfig = emergencyConfig) {
  const pm = 1 / metersPerUnit(left),
    b = new LifeBuilder();
  const points = [
      { x: 200, y: 2000 },
      { x: 3900, y: 2000 },
    ],
    shape = points.map((p) => tileToLngLat(left, p));
  b.line(points, LifeLine.roadMajor, 12, hashString('road'));
  const target = (id: string, kind: 'hospital' | 'police' | 'fire' | 'building', x: number) => ({
    id,
    kind,
    at: tileToLngLat(left, { x, y: 2000 }),
    edge: 0,
    t: (x - 200) / 3700,
    side: -1 as const,
    road: 'road',
    tangent: [1, 0] as [number, number],
  });
  const data = encodeEmergency({
    nodes: shape,
    edges: [{ from: 0, to: 1, length: 3700 / pm, bearing: [0, 0], oneway: 0, shape }],
    targets: [
      target('hospital', 'hospital', 2300),
      target('police', 'police', 900),
      target('fire', 'fire', 1000),
      target('building', 'building', 2400),
    ],
    source: 'Synthetic',
  });
  const world = new LifeWorld(undefined, undefined, undefined, true);
  world.configureEmergency(config, data);
  world.sync([{ key: 'road', tile: left, life: b.finish() }]);
  const life = [...worldTiles(world).values()][0]!;
  life.movers.length = life.pending.length = life.parked.length = life.stalls.length = 0;
  const nw = tileToLngLat(left, { x: 1600, y: 1800 }),
    se = tileToLngLat(left, { x: 2600, y: 2200 });
  const view = {
    bounds: [nw[0], se[1], se[0], nw[1]] as [number, number, number, number],
    spawnMarginM: 12,
  };
  world.updateView(view);
  const step = (dt = 1 / 30) => world.step(dt, undefined, 18, view.bounds);
  return { world, life, data, view, step };
}
export const emergencyMovers = (life: TileLife) => life.movers.filter((m) => !!m.emergency);
export function emergencyReplay(hz: number, kind: 'ambulance' | 'police' | 'fire') {
  const a = [dispatchFixture({ source: 'Synthetic', [kind]: emergencyConfig[kind] })],
    b = [dispatchFixture({ source: 'Synthetic', [kind]: emergencyConfig[kind] })],
    phases = new Set<string>();
  for (let i = 0; i < hz * (kind === 'police' ? 40 : 90); i++) {
    for (let j = 0; j < a.length; j++) {
      a[j]!.step(1 / hz);
      b[j]!.step(1 / hz);
      for (const m of emergencyMovers(a[j]!.life)) phases.add(m.emergency!.phase);
    }
  }
  return {
    a: a.map((f) => completeScenarioState(f.world)),
    b: b.map((f) => completeScenarioState(f.world)),
    phases,
  };
}

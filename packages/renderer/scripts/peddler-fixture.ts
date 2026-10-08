/** Script-only synthetic acceptance: validated pack, safe walking lines, no real-map FPS claim. */
import { readFileSync } from 'node:fs';
import { City } from '@atlas/shared/schemas';
import { LifeBuilder, LifeLine } from '../src/life/geometry';
import { LifeWorld } from '../src/life/simulate';
import { lngLatToTile, metersPerUnit, tileToLngLat } from '../src/raster/geometry';
import type { LifeGrid } from '../src/life/draw';
export const peddlerPerfCity = City.parse(
  JSON.parse(readFileSync(new URL('../../content/cities/naga/city.json', import.meta.url), 'utf8')),
);
export const peddlerPerfTile = { z: 16, x: 55192, y: 30266 };
const perMeter = 1 / metersPerUnit(peddlerPerfTile);
const b = new LifeBuilder();
for (let i = 0; i < 8; i++)
  b.line(
    [
      { x: 1500, y: 1400 + i * 12 * perMeter },
      { x: 1500 + 150 * perMeter, y: 1400 + i * 12 * perMeter },
    ],
    LifeLine.path,
    6,
  );
export const peddlerPerfGeometry = b.finish();
export const peddlerPerfCenter = tileToLngLat(peddlerPerfTile, {
  x: 1500 + 75 * perMeter,
  y: 1400 + 42 * perMeter,
});
export const peddlerPerfWeather = {
  rain: 0,
  minutes: 780,
  sunAltitude: 60,
  windPreset: 'calm' as const,
};
export const peddlerPerfGrid: LifeGrid = {
  cols: 192,
  rows: 108,
  cellWidth: 10,
  cellHeight: 18,
  toCell: (lng, lat) => {
    const p = lngLatToTile(peddlerPerfTile, lng, lat);
    return [
      96 + (p.x - 1500 - 75 * perMeter) / perMeter,
      54 + (p.y - 1400 - 42 * perMeter) / perMeter,
    ];
  },
};
export function makePeddlerPerfWorld(
  module: { LifeWorld: typeof LifeWorld } = { LifeWorld },
  configured = true,
) {
  const world = new module.LifeWorld();
  if (configured) {
    if (typeof world.setPeddlers !== 'function')
      throw new Error('Configured arm lacks setPeddlers');
    world.setPeddlers(peddlerPerfCity.life!.peddlers);
  }
  world.sync([{ key: 'peddlers-hot-0', tile: peddlerPerfTile, life: peddlerPerfGeometry }]);
  for (let i = 0; i < 10; i++)
    world.step(1 / 30, undefined, 19, undefined, undefined, peddlerPerfWeather);
  return world;
}
export function peddlerPerfCounts(world: LifeWorld) {
  const counts: Record<string, number> = {};
  for (const agent of world.visible(19, 1, peddlerPerfCenter, peddlerPerfWeather))
    if (agent.peddler) counts[agent.peddler.id] = (counts[agent.peddler.id] ?? 0) + 1;
  return counts;
}

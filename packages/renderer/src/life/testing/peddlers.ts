import type { PeddlerConfig } from '@atlas/shared';
import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { PeddlerPopulation, type PeddlerSignals } from '../peddlers';
import { PolygonIndex, type Body } from '../occupancy';
import { carriageways } from '../terrain';

export const peddlerConfig: PeddlerConfig = {
  id: 'sample-goods',
  label: 'Sample vendor',
  prop: 'basket',
  hours: { from: 5, to: 11 },
  lines: ['path', 'plaza'],
  perTile: 2,
  source: [{ title: 'Illustrative test configuration' }],
};
export const peddlerTile = { z: 16, x: 55192, y: 30266 };
export const peddlerPM = 1 / metersPerUnit(peddlerTile);
export const peddlerCenter = tileToLngLat(peddlerTile, { x: 1500, y: 1500 });
export const peddlerWeather: PeddlerSignals = {
  minutes: 480,
  rain: 0,
  sunAltitude: 20,
  wet: false,
  windPreset: 'calm',
};
export function peddlerGeometry() {
  const b = new LifeBuilder(),
    pm = peddlerPM;
  b.line(
    [
      { x: 1000, y: 1500 },
      { x: 1000 + 100 * pm, y: 1500 },
    ],
    LifeLine.path,
    4,
  );
  b.line(
    [
      { x: 1000 + 100 * pm, y: 1500 },
      { x: 1000 + 100 * pm, y: 1500 + 100 * pm },
    ],
    LifeLine.plaza,
    4,
  );
  b.site({ x: 1000 + 50 * pm, y: 1500 + 5 * pm }, 1);
  return b.finish();
}
export function peddlerFixture(
  configs = [peddlerConfig],
  geo = peddlerGeometry(),
  seed = 42,
  ordinary: Body[] = [],
) {
  const blocked = new PolygonIndex();
  for (const area of geo.areas ?? [])
    if (area.kind !== 'crossing')
      blocked.add(
        area.rings.map((r) => r.map((p) => ({ x: p.x / peddlerPM, y: p.y / peddlerPM }))),
      );
  for (const polygon of carriageways(geo, peddlerPM))
    blocked.add(polygon.map((r) => r.map((p) => ({ x: p.x / peddlerPM, y: p.y / peddlerPM }))));
  const population = new PeddlerPopulation(
    {
      tile: peddlerTile,
      geo,
      perMeter: peddlerPM,
      seed,
      safe: (from, to) => !from.some((body, i) => blocked.sweptHits(body, to[i]!)),
      ordinary: () => ordinary,
    },
    configs,
  );
  return { population, blocked, geo, ordinary };
}

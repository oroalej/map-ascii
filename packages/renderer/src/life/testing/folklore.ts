import { epochDay } from '@atlas/shared';
import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import type { RuntimeFolklore } from '../folklore-config';
import type { FolkloreTile } from '../folklore-geometry';
import { left } from './continuity';

export const folkloreConfig: RuntimeFolklore = {
  hours: { from: 1320, to: 240 },
  ghosts: {
    sites: ['cemetery', 'worship', 'hospital'],
    per_cemetery: [1, 2],
    undas_per_cemetery: [3, 6],
    undas_season: 'all-saints',
    site_share: 1,
    range_m: [30, 50],
  },
  manananggal: {
    window: { from: { month: 10, day: 31 }, to: { month: 11, day: 30 } },
    night_chance: 1,
  },
  undasWindow: { from: { month: 10, day: 31 }, to: { month: 11, day: 2 } },
};
export const calendar = (month = 7, day = 1) => ({ epochDay: epochDay(2026, month, day) });
export const rectangle = (x: number, y: number, w: number, h = w) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];
export function folkloreTile(): FolkloreTile {
  const b = new LifeBuilder(),
    pm = 1 / metersPerUnit(left);
  b.cemeteryArea('cemetery', [rectangle(500, 500, 1800), rectangle(1200, 1200, 200)]);
  b.grave({ x: 600, y: 600 }, 'cemetery', 1);
  b.place({ x: 2500, y: 2600 }, 'worship', 0, false, undefined, undefined, 'church');
  b.hospital('hospital', { x: 2700, y: 2600 }, 0);
  b.line(
    [
      { x: 0, y: 2600 },
      { x: 4095, y: 2600 },
    ],
    LifeLine.path,
  );
  b.field('field', 'grass', [rectangle(2300, 1000, 300)]);
  for (let i = 0; i < 3; i++) {
    const p = { x: 2800 + i * 100, y: 1400 };
    b.roof(`roof-${i}`, [rectangle(p.x - 30, p.y - 30, 60)], p);
  }
  return {
    key: `${left.z}/${left.x}/${left.y}`,
    tile: left,
    geo: b.finish(),
    perMeter: pm,
    owns: () => true,
  };
}
export const folkloreCenter = tileToLngLat(left, { x: 2048, y: 2048 });

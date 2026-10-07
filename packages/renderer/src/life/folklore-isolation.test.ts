import { expect, it, describe } from 'vitest';
import { LifeWorld } from './simulate';
import { calendar, folkloreConfig, folkloreTile, folkloreCenter } from './testing/folklore';
import { completeScenarioState, scenarioLife, worldTiles, retiredTiles } from './testing/scenarios';
import { right } from './testing/continuity';

describe.each([7, 11])('ghost isolation in month %s', (month) => {
  const a = new LifeWorld(),
    b = new LifeWorld(undefined, undefined, undefined, undefined, undefined, false),
    t = folkloreTile();
  const junction = scenarioLife('junction');
  t.geo = { ...junction, cemeteryAreas: t.geo.cemeteryAreas, hospitals: t.geo.hospitals };
  const config = {
    ...folkloreConfig,
    manananggal: { ...folkloreConfig.manananggal, night_chance: 0 },
  };
  const entry = { key: t.key, tile: t.tile, life: t.geo },
    retired = { key: 'right', tile: right, life: structuredClone(t.geo) };
  for (const w of [a, b]) {
    w.setFolklore(config);
    w.sync([structuredClone(entry), structuredClone(retired)]);
    w.sync([structuredClone(entry)]);
  }
  let active = false;
  for (let chunk = 0; chunk < 3; chunk++)
    it(`compares physical state through part ${chunk + 1}`, () => {
      for (let i = chunk * 40; i < (chunk + 1) * 40; i++) {
        const total = 1260 + i * 4,
          minutes = total % 1440,
          date = calendar(month, total >= 1440 ? 2 : 1);
        for (const w of [a, b])
          w.step(0.1, undefined, 18, undefined, undefined, {
            rain: 0,
            minutes,
            folkloreDate: date,
          });
        active ||= a
          .visibleFolklore(18, folkloreCenter)
          .sprites.some((s) => s.kind === 'ghost' && s.alpha > 0);
        expect(b.visibleFolklore(18, folkloreCenter).sprites).toEqual([]);
        expect(completeScenarioState(a)).toEqual(completeScenarioState(b));
      }
    });
  it('compares 32 future draws from every active and retired physical RNG', () => {
    expect(active).toBe(true);
    for (const w of [a, b]) {
      w.sync([structuredClone(entry), structuredClone(retired)]);
      w.sync([structuredClone(entry)]);
    }
    const tiles = (w: LifeWorld) => [
      ...worldTiles(w).values(),
      ...[...retiredTiles(w).values()].map((t) => t.life),
    ];
    const aa = tiles(a),
      bb = tiles(b);
    expect(aa.length).toBeGreaterThan(1);
    for (let i = 0; i < aa.length; i++) {
      const x = aa[i] as unknown as Record<string, unknown>,
        y = bb[i] as unknown as Record<string, unknown>;
      const streams = Object.keys(x).filter(
        (k) => (/rng$/i.test(k) || k === 'looks') && typeof x[k] === 'function',
      );
      expect(streams).toHaveLength(14);
      for (const key of streams)
        expect(Array.from({ length: 32 }, () => (x[key] as () => number)())).toEqual(
          Array.from({ length: 32 }, () => (y[key] as () => number)()),
        );
    }
  });
});

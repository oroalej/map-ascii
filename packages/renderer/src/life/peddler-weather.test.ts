import { expect, it, vi } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { peddlerFixture, peddlerConfig, peddlerWeather, peddlerPM } from './testing/peddlers';
import type { PeddlerConfig } from '@atlas/shared';
function fixture(cover: 'shelter' | 'shade' | 'none', prop: PeddlerConfig['prop'] = 'basket') {
  const b = new LifeBuilder();
  b.line(
    [
      { x: 1000, y: 1500 },
      { x: 1000 + 30 * peddlerPM, y: 1500 },
    ],
    LifeLine.path,
    4,
  );
  if (cover === 'shelter') b.site({ x: 1000 + 10 * peddlerPM, y: 1500 }, 2, 0, true);
  if (cover === 'shade') b.perch({ x: 1000 + 10 * peddlerPM, y: 1500 });
  const { population } = peddlerFixture(
    [{ ...peddlerConfig, hours: { from: 5, to: 17 }, perTile: 1, prop, lamp: true }],
    b.finish(),
  );
  population.step(0, { ...peddlerWeather, zoom: 19 }, 0);
  const owner = population.owners[0]!;
  owner.umbrellaRank = 1;
  return { population, owner };
}
it('opens carriers and cart parasols in light rain, folds in gusts, and forbids new heavy/storm births', () => {
  for (const prop of ['pole-buckets', 'box-cart'] as const) {
    const { population, owner } = fixture('none', prop);
    owner.umbrellaRank = 0;
    population.step(1, { ...peddlerWeather, rain: 0.3 }, 0);
    const a = population.visible(owner, { ...peddlerWeather, rain: 0.3 });
    if (prop === 'box-cart') expect(a.peddler!.parasol).toBe(1);
    else expect(a.people![0]!.canopy?.figure).toBe('pole-buckets');
    population.step(1, { ...peddlerWeather, windPreset: 'gusty' }, 0);
    expect(owner.canopy).toBe(0);
  }
  for (const weather of [{ rain: 0.8 }, { rain: 0, windPreset: 'storm' as const }]) {
    const { population } = peddlerFixture();
    population.step(1, { ...peddlerWeather, ...weather }, 0);
    expect(population.owners).toHaveLength(0);
  }
});
it('takes a separate mapped shelter visit, then releases once with a clearing token', () => {
  const { population, owner } = fixture('shelter');
  for (let i = 0; i < 60; i++) population.step(1, { ...peddlerWeather, rain: 0.7, wet: true }, 0);
  expect(owner.sheltered).toBe(true);
  expect(owner.callToken).toBe(0);
  const stay = [owner.x, owner.y];
  for (let i = 0; i < 10; i++) population.step(1, { ...peddlerWeather, rain: 0.7, wet: true }, 0);
  expect([owner.x, owner.y]).toEqual(stay);
  for (let i = 0; i < 120; i++) population.step(1, peddlerWeather, 0);
  expect(owner.resumeToken).toBe(1);
  expect(owner.sheltered).toBe(false);
  expect(owner.visit).toBeUndefined();
  expect([owner.x, owner.y]).not.toEqual(stay);
});
it('stands at a checked endpoint when no cover is reachable, without calling, and resumes', () => {
  const { population, owner } = fixture('none');
  for (let i = 0; i < 60; i++) population.step(1, { ...peddlerWeather, rain: 0.7, wet: true }, 0);
  expect(owner.visit?.phase).toBe('stay');
  expect(owner.visit?.fallback).toBe(true);
  expect(owner.callToken).toBe(0);
  expect(owner.distance === 0 || owner.distance === owner.route.length).toBe(true);
  for (let i = 0; i < 100; i++) population.step(1, peddlerWeather, 0);
  expect(owner.resumeToken).toBe(1);
});
it('prefers mapped shade for hot call stops and preserves lamps through physical inspection', () => {
  const { population, owner } = fixture('shade');
  owner.nextCall = 0;
  for (let i = 0; i < 50 && !owner.shaded; i++)
    population.step(1, { ...peddlerWeather, minutes: 780, sunAltitude: 60 }, 0);
  expect(owner.shaded).toBe(true);
  expect(owner.callToken).toBeGreaterThan(0);
  const env = {
    ...peddlerWeather,
    sunAltitude: -10,
    windPreset: 'gusty' as const,
    wind: { dir: [1, 0] as const, strength: 1 },
  };
  const before = population.visible(owner, env).peddler!.lamp;
  expect(before).toBeGreaterThanOrEqual(0.5);
  expect(before).toBeLessThanOrEqual(1);
  population.context.held = () => true;
  population.step(1, env, 0);
  expect(population.visible(owner, env).peddler!.lamp).toBe(before);
  expect(population.visible(owner, peddlerWeather).peddler!.lamp).toBe(0);
});
it('emits one bounded fry-cart stop puff without sampling movement randomness', () => {
  const { population, owner } = fixture('none', 'fry-cart');
  owner.nextCall = 0;
  const rng = vi.fn(owner.rng);
  owner.rng = rng;
  population.step(0.1, peddlerWeather, 0);
  expect(rng).toHaveBeenCalledTimes(2);
  expect(population.visiblePuff(owner, 3)).toHaveLength(5);
  expect(population.visiblePuff(owner, 3)[0]).toBe(3);
  const puff = { ...owner.puff! },
    clock = owner.effectClock;
  population.context.held = () => true;
  population.step(1, peddlerWeather, 0);
  expect(owner.puff).toEqual(puff);
  expect(owner.effectClock).toBe(clock);
  population.context.held = () => false;
  population.step(2, peddlerWeather, 0);
  expect(population.visiblePuff(owner, 3)).toEqual([]);
});

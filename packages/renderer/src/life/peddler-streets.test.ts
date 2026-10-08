import { describe, expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { peddlerBodies } from './peddlers';
import { PolygonIndex } from './occupancy';
import { LifeWorld } from './simulate';
import { EXTENT, tileToLngLat } from '../raster/geometry';
import {
  peddlerConfig,
  peddlerFixture,
  peddlerPM,
  peddlerTile,
  peddlerWeather,
} from './testing/peddlers';

const config = { ...peddlerConfig, lines: ['street' as const], share: 1 };
const pm = peddlerPM;
const ring = (x: number, y: number, width: number, height: number) => [
  { x, y },
  { x: x + width * pm, y },
  { x: x + width * pm, y: y + height * pm },
  { x, y: y + height * pm },
  { x, y },
];

describe('street-only peddler placement', () => {
  it('does not use a street excluded by the decoded public-street identities', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 1500 },
        { x: 1000 + 100 * pm, y: 1500 },
      ],
      LifeLine.roadMinor,
      6,
      42,
    );
    b.peddlerStreet();
    const { population } = peddlerFixture([config], b.finish());
    population.step(1, peddlerWeather, 0);
    expect(population.owners).toHaveLength(0);
  });

  it('respects a compound footprint supplied only by a neighboring tile', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 3800, y: 1500 },
        { x: 3800 + 30 * pm, y: 1500 },
      ],
      LifeLine.roadMinor,
      6,
    );
    const street = b.finish(),
      neighbor = new LifeBuilder();
    neighbor.area('peddler-exclusion', [ring(3800 - EXTENT - 10 * pm, 1500 - 20 * pm, 50, 40)]);
    const count = (withGrounds: boolean) => {
      const world = new LifeWorld();
      world.setPeddlers([config]);
      world.sync([
        { key: 'street', tile: peddlerTile, life: street },
        ...(withGrounds
          ? [
              {
                key: 'neighbor',
                tile: { ...peddlerTile, x: peddlerTile.x + 1 },
                life: neighbor.finish(),
              },
            ]
          : []),
      ]);
      world.step(0.1, undefined, 19, undefined, undefined, peddlerWeather);
      return world
        .visible(19, 1, tileToLngLat(peddlerTile, { x: 3850, y: 1500 }), {
          rain: peddlerWeather.rain,
          sunAltitude: 20,
        })
        .filter((agent) => agent.peddler).length;
    };
    expect(count(false)).toBeGreaterThan(0);
    expect(count(true)).toBe(0);
  });
  it('never populates standalone paths or plaza outlines', () => {
    const b = new LifeBuilder();
    for (const kind of [LifeLine.path, LifeLine.plaza])
      b.line(
        [
          { x: 1000, y: 1500 },
          { x: 1000 + 100 * pm, y: 1500 },
        ],
        kind,
        6,
      );
    const { population } = peddlerFixture([config], b.finish());
    population.step(1, peddlerWeather, 0);
    expect(population.owners).toHaveLength(0);
  });

  it.each(['basket', 'box-cart', 'flatbed-cart'] as const)(
    'keeps the complete %s footprint outside street carriageways and compound grounds',
    (prop) => {
      const b = new LifeBuilder();
      b.line(
        [
          { x: 1000, y: 1500 },
          { x: 1000 + 120 * pm, y: 1500 },
        ],
        LifeLine.roadMinor,
        6,
      );
      // A school/establishment plot occupies one frontage and part of the street's length.
      const grounds = [ring(1000 + 35 * pm, 1500 + 3 * pm, 50, 40)];
      b.area('peddler-exclusion', grounds);
      const { population, blocked } = peddlerFixture([{ ...config, prop }], b.finish());
      const exclusion = new PolygonIndex();
      exclusion.add(grounds.map((r) => r.map((p) => ({ x: p.x / pm, y: p.y / pm }))));
      let observations = 0;
      for (let i = 0; i < 180; i++) {
        population.step(1, peddlerWeather, 0);
        for (const owner of population.owners) {
          const bodies = peddlerBodies(prop, owner, owner.hx, owner.hy);
          expect(blocked.hits(bodies)).toBe(false);
          expect(exclusion.hits(bodies)).toBe(false);
          expect(Math.abs(owner.y - 1500 / pm)).toBeGreaterThan(3);
          expect(Math.abs(owner.y - 1500 / pm)).toBeLessThan(7);
          observations++;
        }
      }
      expect(observations).toBeGreaterThan(0);
    },
  );

  it('rejects internal roads enclosed by a campus or establishment boundary', () => {
    const b = new LifeBuilder();
    b.line(
      [
        { x: 1000, y: 1500 },
        { x: 1000 + 100 * pm, y: 1500 },
      ],
      LifeLine.roadMinor,
      6,
    );
    b.area('peddler-exclusion', [ring(1000 - 10 * pm, 1500 - 20 * pm, 120, 40)]);
    const { population } = peddlerFixture([config], b.finish());
    population.step(1, peddlerWeather, 0);
    expect(population.owners).toHaveLength(0);
  });
});

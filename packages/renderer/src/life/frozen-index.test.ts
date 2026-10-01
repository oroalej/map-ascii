import { describe, expect, it } from 'vitest';
import { FrozenPolygonIndex, PolygonIndex, type Body } from './occupancy';
import { makeScenario } from './testing/scenarios';
import { snapshotOf } from './terrain-snapshot';

describe('transferred polygon indexes', () => {
  it('matches mutable terrain for seeded bodies, bin edges, degenerate and distant bodies', () => {
    const terrain = makeScenario('crossroads', 4).world.cellTerrain()!;
    const { snapshot, transferables } = snapshotOf(terrain);
    expect(transferables).toHaveLength(21);
    const received = structuredClone(snapshot, { transfer: transferables });
    expect(transferables.every((buffer) => buffer.byteLength === 0)).toBe(true);
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const bodies: Body[] = Array.from({ length: 5000 }, (_, i) => {
      const angle = random() * Math.PI * 2;
      return {
        x: i % 7 === 0 ? Math.floor(random() * 100) * 12 : random() * 1400 - 100,
        y: i % 11 === 0 ? Math.floor(random() * 100) * 12 : random() * 1400 - 100,
        hx: Math.cos(angle),
        hy: Math.sin(angle),
        length: random() * 15,
        width: i % 13 === 0 ? 0 : random() * 6,
      };
    });
    bodies.push({ x: 100000, y: -100000, hx: 1, hy: 0, length: 1, width: 1 });
    for (const name of ['roads', 'forbidden', 'trees'] as const) {
      const frozen = new FrozenPolygonIndex(received[name]);
      for (const body of bodies) expect(frozen.hits([body])).toBe(terrain[name].hits([body]));
      // Multiple bodies must reset the per-body deduplication state.
      for (let i = 0; i < bodies.length; i += 3)
        expect(frozen.hits(bodies.slice(i, i + 3))).toBe(
          terrain[name].hits(bodies.slice(i, i + 3)),
        );
    }
  });

  it('never hits an empty index', () => {
    const frozen = new FrozenPolygonIndex(new PolygonIndex().toFlat());
    expect(frozen.hits([])).toBe(false);
    expect(frozen.hits([{ x: 0, y: 0, hx: 1, hy: 0, length: 12, width: 12 }])).toBe(false);
  });

  it('retains polygon holes and float64 bin keys above int32', () => {
    const index = new PolygonIndex();
    const square = (lo: number, hi: number) => [
      { x: lo, y: lo },
      { x: hi, y: lo },
      { x: hi, y: hi },
      { x: lo, y: hi },
      { x: lo, y: lo },
    ];
    index.add([square(0, 48), square(12, 36)]);
    const flat = index.toFlat();
    expect(flat.keys.some((key) => key > 2 ** 31)).toBe(true);
    const frozen = new FrozenPolygonIndex(flat);
    for (const [x, expected] of [
      [6, true],
      [24, false],
      [42, true],
      [60, false],
    ] as const) {
      const body = { x, y: x, hx: 1, hy: 0, length: 1, width: 1 };
      expect(frozen.hits([body])).toBe(expected);
      expect(frozen.hits([body])).toBe(index.hits([body]));
    }
  });
});

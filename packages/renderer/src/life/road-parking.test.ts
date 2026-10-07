import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LifeBuilder, LifeLine } from './geometry';
import { TileLife } from './simulate';
import { roadParkingFixture } from './testing/road-parking';

// Complete surviving PRE records/paints/strip decisions from c6303fd796dc87b56a5913bd4ce5f5fc34228bd4.
// To regenerate, inject PRE's LifeBuilder/LifeLine into testing/road-parking.ts and construct
// PRE's TileLife at this tile with each seed below. Keep parked records outside 750 < y < 1000
// (the major-road curb band), preserving their full contents/order, and remove strip 0 from
// [...life.parkingLines]. SHA-256 the UTF-8 JSON.stringify({ records, strips }) with that key order.
// Seeds 19 and 77 each remove 127 major-curb records; the remaining mid/minor/lot records are complete.
it.each([
  [1, '2566f345c065bf45609bdfd5baf5abcdc36a4a6ef5bf1bc10479425058c15098'],
  [2, 'd15c0b2120d365e2bf016d0c254031c040e82d5a201d6751963271576e33f413'],
  [3, '68207789fc278bd49fc6d85114e3fcc9467ba0815f3bc25d467fcfe73f7dab78'],
  [7, '32ef2e89e41d797881b798c8598b5d805096022b23dd5119a3a129b13e67554f'],
  [19, '4a6d1287c7735042aecc2ed228a521d59716a9baeefe69d61f7330183b36a5ce'],
  [42, '920922f8b840d90115f9f4cb4ac1c507683aebe0ec426606541034ac1c1653fa'],
  [77, '8fe9769b0b6dd765f82df8ea777f2616d7329e6ede982b075f30f8d62baf079a'],
] as const)(
  'preserves mid/minor and lot parking after deferred major filtering, seed %s',
  (seed, expected) => {
    const life = new TileLife(
      { z: 16, x: 55192, y: 30266 },
      roadParkingFixture(LifeBuilder, LifeLine),
      seed,
    );
    const records = life.parked;
    // Audit internal strip decisions as well as public parked records against PRE.
    const strips = [...(life as unknown as { parkingLines: ReadonlySet<number> }).parkingLines];
    const hash = createHash('sha256').update(JSON.stringify({ records, strips })).digest('hex');
    expect(hash).toBe(expected);
    expect(strips).not.toContain(0);
    expect(records.some((p) => p.y > 750 && p.y < 1000)).toBe(false);
  },
);

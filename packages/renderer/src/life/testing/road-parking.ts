import type { LifeBuilder, LifeLine } from '../geometry';

/** Mixed classes, split identities, rejected footprints and mapped lots, shared with the PRE probe. */
export function roadParkingFixture(Builder: typeof LifeBuilder, Line: typeof LifeLine) {
  const b = new Builder();
  b.line(
    [
      { x: 0, y: 800 },
      { x: 4095, y: 800 },
    ],
    Line.roadMajor,
    14,
    77,
  );
  for (const [a, z] of [
    [0, 1500],
    [1500, 2800],
    [2800, 4095],
  ])
    b.line(
      [
        { x: a!, y: 1900 },
        { x: z!, y: 1900 },
      ],
      Line.roadMid,
      14,
      77,
    );
  b.line(
    [
      { x: 0, y: 2800 },
      { x: 4095, y: 2800 },
    ],
    Line.roadMinor,
    14,
    99,
  );
  b.line(
    [
      { x: 1000, y: 600 },
      { x: 1000, y: 1100 },
    ],
    Line.roadMinor,
    6,
    100,
  );
  b.area('parking-exclusion', [
    [
      { x: 1000, y: 2740 },
      { x: 2000, y: 2740 },
      { x: 2000, y: 2860 },
      { x: 1000, y: 2860 },
    ],
  ]);
  for (const x of [300, 500, 700]) b.spot({ x, y: 700 }, 1, 0);
  return b.finish();
}

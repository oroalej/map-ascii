import { expect, it } from 'vitest';
import { localMetricProjection, type StreetRoute } from '@atlas/shared';
import { formationLayout } from './formation-layout';
import { GroundProcessionScene } from './procession-street';
const street: StreetRoute = {
  id: 'test',
  kind: 'procession',
  title: { en: 'Test' },
  status: 'draft',
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: 0,
    start: '12:00',
    duration_min: 10,
    timezone: 'Asia/Manila',
  },
  route: [
    [0, 0],
    [0.05, 0],
  ],
  length_m: 5566,
  segments: [{ id: 'osm:way/1', width_m: 5, clear_m: 5, sidewalk_m: 0 }],
  blocked: [],
  formation: { images: 2, bearers: 40, ranks: 20, columns: 6, marshals: 16 },
};
it('keeps all members clear before a wide-to-constrained transition and through a bend', () => {
  const f = localMetricProjection([0, 0]),
    q = (x: number, y: number) => f.from([x, y]);
  const box = (w: number, s: number, e: number, n: number) => [
    q(w, s),
    q(e, s),
    q(e, n),
    q(w, n),
    q(w, s),
  ];
  const route: StreetRoute = {
    ...street,
    route: [q(-2000, 0), q(0, 0), q(0, 2000)],
    length_m: 4000,
    segments: [
      { id: 'osm:way/1', width_m: 8, clear_m: 8, sidewalk_m: 0 },
      { id: 'osm:way/2', width_m: 8, clear_m: 4.5, sidewalk_m: 0 },
    ],
    blocked: [box(2.5, 50, 10, 1200)],
  };
  const layout = formationLayout(route),
    scene = new GroundProcessionScene(route);
  expect(layout.columns).toBe(4);
  expect(layout.actors).toHaveLength(218);
  for (const head of [1950, 1990, 2000, 2010, 2050]) {
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 32; i++) {
      const p = (lo + hi) / 2;
      if (layout.head(p) < head) lo = p;
      else hi = p;
    }
    expect(scene.agents((lo + hi) / 2, 0)).toHaveLength(218);
  }
});
it('keeps every physical member when narrowing and times the complete stream', () => {
  const layout = formationLayout(street),
    scene = new GroundProcessionScene(street);
  expect(layout.actors).toHaveLength(218);
  expect(layout.columns).toBe(4);
  expect(Math.max(...layout.actors.map((a) => Math.abs(a.off)))).toBeLessThan(2);
  expect(scene.agents(0.5, 0)).toHaveLength(218);
  expect(scene.agents(0, 0)).toHaveLength(0);
  expect(scene.agents(1, 0)).toHaveLength(0);
  expect(layout.head(1) - layout.tail).toBeCloseTo(street.length_m);
});
it('shares all 72 blocks, six bands and complete tail with the simulated actors', () => {
  const event: StreetRoute = {
    ...street,
    kind: 'parade',
    formation: {
      contingents: 72,
      ranks: 8,
      columns: 6,
      bands: 6,
      band: 24,
      color_guard: 8,
      vehicles: [],
    },
  };
  const layout = formationLayout(event);
  expect(layout.actors).toHaveLength(152);
  expect(layout.blocks).toHaveLength(72);
  expect(layout.blocks.every((b) => b.count === 48 && b.columns === 4 && b.length === 24)).toBe(
    true,
  );
  for (let i = 1; i < layout.blocks.length; i++)
    expect(layout.blocks[i]!.back).toBeGreaterThan(
      layout.blocks[i - 1]!.back + layout.blocks[i - 1]!.length,
    );
  expect(layout.tail).toBeGreaterThan(layout.blocks.at(-1)!.back + layout.blocks.at(-1)!.length);
});

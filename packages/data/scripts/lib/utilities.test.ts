import { describe, expect, it } from 'vitest';
import { utilityRecordId, type BBox, type UtilityPole } from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import {
  canonicalUtilityLine,
  generateUtilities,
  utilityEligible,
  utilityProjection,
  utilityCoverageBounds,
} from './utilities';

const bounds: BBox = [123.17, 13.6, 123.2, 13.64];
const projection = utilityProjection(bounds);
const road = (id: string, points: [number, number][], highway = 'primary'): AtlasFeature => ({
  type: 'Feature',
  tippecanoe: { layer: 'roads', minzoom: 6, maxzoom: 16 },
  properties: { id, class: 'road_major', highway, width: 8 },
  geometry: { type: 'LineString', coordinates: points.map(projection.unproject) },
});
const poles = (result: ReturnType<typeof generateUtilities>): UtilityPole[] =>
  result.records.flatMap((r) => (r.kind === 'pole' ? [r.pole] : []));

function connected(result: ReturnType<typeof generateUtilities>, roads: string[]) {
  const adjacency = new Map<string, Set<string>>();
  for (const record of result.records)
    if (record.kind === 'span') {
      const { from, to } = record.span;
      for (const [a, b] of [
        [from.id, to.id],
        [to.id, from.id],
      ]) {
        const neighbors = adjacency.get(a!) ?? new Set<string>();
        neighbors.add(b!);
        adjacency.set(a!, neighbors);
      }
      const a = projection.project(from.at),
        b = projection.project(to.at);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(65 + 1e-6);
    }
  const supports = poles(result),
    start = supports.find((p) => p.road === roads[0])!;
  expect(start).toBeDefined();
  const seen = new Set<string>(),
    pending = [start.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(adjacency.get(id) ?? []));
  }
  for (const road of roads) {
    const nodes = supports.filter((p) => p.road === road);
    expect(nodes.length).toBeGreaterThan(0);
    expect(
      nodes.every((p) => seen.has(p.id)),
      road,
    ).toBe(true);
  }
}

describe('baked utility network', () => {
  it('retains streets in the visible map region outside the city bounding box', () => {
    const city: BBox = [...projection.unproject([0, -200]), ...projection.unproject([200, 200])];
    const region: BBox = [
      ...projection.unproject([-200, -200]),
      ...projection.unproject([200, 200]),
    ];
    const outside = road('visible-west', [
      [-180, 0],
      [-20, 0],
    ]);
    expect(poles(generateUtilities([outside], city))).toHaveLength(0);
    expect(
      poles(generateUtilities([outside], utilityCoverageBounds(city, region))).length,
    ).toBeGreaterThan(0);
  });
  it('keeps many short OSM way fragments connected along one street', () => {
    const roads = Array.from({ length: 16 }, (_, i) =>
      road(`short-${i}`, [
        [i * 10, 0],
        [(i + 1) * 10, 0],
      ]),
    );
    const result = generateUtilities(roads, bounds);
    connected(
      result,
      roads.map((r) => r.properties.id),
    );
    expect(result.stats.continuity.unresolvedGroups).toBe(0);
    expect(
      generateUtilities(
        roads
          .slice()
          .reverse()
          .map((r) => ({
            ...r,
            geometry: {
              type: 'LineString',
              coordinates:
                r.geometry.type === 'LineString' ? r.geometry.coordinates.slice().reverse() : [],
            },
          })),
        bounds,
      ),
    ).toEqual(result);
  });

  it('connects every branch of a T junction and two roads meeting at interior vertices', () => {
    const through = road('through', [
      [-250, 0],
      [0, 0],
      [250, 0],
    ]);
    for (const branch of [
      road('branch', [
        [0, 0],
        [0, 250],
      ]),
      road('branch', [
        [0, -250],
        [0, 0],
        [0, 250],
      ]),
    ]) {
      const result = generateUtilities([through, branch], bounds);
      connected(result, ['through', 'branch']);
      expect(result.stats.junctions).toBeGreaterThan(0);
    }
    const branches = [
      road('west', [
        [-250, 0],
        [0, 0],
      ]),
      road('east', [
        [0, 0],
        [250, 0],
      ]),
      road('north', [
        [0, 0],
        [0, 250],
      ]),
      road('south', [
        [0, -250],
        [0, 0],
      ]),
    ];
    const result = generateUtilities(branches, bounds);
    connected(
      result,
      branches.map((r) => r.properties.id),
    );
    expect(result.stats.junctions).toBe(3);
    expect(result.stats.continuity.connectedGroups).toBe(1);
  });

  it('follows a short source connector even when it has no safe support location', () => {
    const roads = [
      road('left', [
        [-250, 0],
        [0, 0],
      ]),
      road('connector', [
        [0, 0],
        [10, 0],
      ]),
      road('right', [
        [10, 0],
        [250, 0],
      ]),
    ];
    const blocked: AtlasFeature = {
      type: 'Feature',
      properties: { id: 'b', class: 'building', height: 10 },
      tippecanoe: { layer: 'buildings', minzoom: 6, maxzoom: 16 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-1, -8],
            [11, -8],
            [11, 8],
            [-1, 8],
            [-1, -8],
          ].map((p) => projection.unproject(p as [number, number])),
        ],
      },
    };
    const result = generateUtilities([...roads, blocked], bounds);
    expect(poles(result).filter((p) => p.road === 'connector')).toHaveLength(0);
    connected(result, ['left', 'right']);
    expect(result.stats.continuity.unresolvedGroups).toBe(0);
  });

  it('repairs long rejected-slot gaps on the opposite verge without placing supports inside buildings', () => {
    const r = road('gap', [
      [-250, 0],
      [250, 0],
    ]);
    const side = poles(generateUtilities([r], bounds)).find((p) => !p.partner)!.normal[1];
    const ring = [
      [-75, side * 4.01],
      [75, side * 4.01],
      [75, side * 12],
      [-75, side * 12],
      [-75, side * 4.01],
    ] as [number, number][];
    const blocked: AtlasFeature = {
      type: 'Feature',
      properties: { id: 'b', class: 'building', height: 10 },
      tippecanoe: { layer: 'buildings', minzoom: 6, maxzoom: 16 },
      geometry: { type: 'Polygon', coordinates: [ring.map(projection.unproject)] },
    };
    const result = generateUtilities([r, blocked], bounds);
    connected(result, ['gap']);
    expect(result.stats.continuity.repairPoles).toBeGreaterThan(0);
    expect(result.stats.continuity.corridorGaps).toBe(0);
    for (const p of poles(result)) {
      const [x, y] = projection.project(p.at);
      expect(x > -75 && x < 75 && y * side > 4.01 && y * side < 12).toBe(false);
    }
  });
  it('uses original highway tags, excludes regional roads and tertiary streets', () => {
    expect(
      utilityEligible(
        road(
          'r',
          [
            [0, 0],
            [300, 0],
          ],
          'secondary_link',
        ),
      ),
    ).toBe(true);
    expect(
      utilityEligible(
        road(
          'r',
          [
            [0, 0],
            [300, 0],
          ],
          'tertiary',
        ),
      ),
    ).toBe(false);
    const f = road('r', [
      [0, 0],
      [300, 0],
    ]);
    f.properties.region = true;
    expect(utilityEligible(f)).toBe(false);
  });

  it('is identical across input order, reversed ways and rotated closed rings', () => {
    const a = road('a', [
      [-300, 0],
      [0, 0],
      [300, 0],
    ]);
    const b = road('b', [
      [0, 0],
      [0, 300],
    ]);
    const original = generateUtilities([a, b], bounds);
    const reverse = structuredClone(a);
    if (reverse.geometry.type === 'LineString') reverse.geometry.coordinates.reverse();
    expect(generateUtilities([b, reverse], bounds)).toEqual(original);
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    expect(canonicalUtilityLine(ring)).toEqual(
      canonicalUtilityLine([
        [1, 1],
        [1, 0],
        [0, 0],
        [0, 1],
        [1, 1],
      ]),
    );
    expect(new Set(original.records.map(utilityRecordId)).size).toBe(original.records.length);
  });

  it('keeps 18–42m main spacing and only connects drops to their explicit parent', () => {
    const result = generateUtilities(
      [
        road('r', [
          [-900, 0],
          [900, 0],
        ]),
      ],
      bounds,
    );
    const main = poles(result)
      .filter((p) => !p.partner)
      .map((p) => projection.project(p.at)[0])
      .sort((a, b) => a - b);
    expect(main.length).toBeGreaterThan(40);
    for (let i = 1; i < main.length; i++)
      expect(main[i]! - main[i - 1]!).toBeGreaterThanOrEqual(18 - 1e-6);
    for (let i = 1; i < main.length; i++)
      expect(main[i]! - main[i - 1]!).toBeLessThanOrEqual(42 + 1e-6);
    for (const p of poles(result).filter((p) => p.partner)) {
      const spans = result.records.filter(
        (r) => r.kind === 'span' && [r.span.from.id, r.span.to.id].includes(p.id),
      );
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({ kind: 'span', span: { kind: 'crossing' } });
    }
  });

  it('reuses exact retained lamp coordinates and never assigns one lamp twice', () => {
    const roads = [
      road('r', [
        [-900, 0],
        [900, 0],
      ]),
    ];
    const baseline = poles(generateUtilities(roads, bounds)).filter((p) => !p.partner);
    const lamps = baseline.map((p, i) => ({
      key: `lamp-${i}`,
      road: 'r',
      at: projection.unproject([projection.project(p.at)[0], Math.sign(p.normal[1]) * 4.5]),
    }));
    const shared = poles(generateUtilities(roads, bounds, lamps)).filter((p) => p.sharedLamp);
    expect(shared.length).toBeGreaterThan(5);
    expect(new Set(shared.map((p) => p.sharedLamp)).size).toBe(shared.length);
    for (const p of shared) {
      expect(p.at).toEqual(lamps.find((l) => l.key === p.sharedLamp)!.at);
      expect(p.transformer).toBe(false);
    }
  });

  it('rejects solid footprints, preserves holes, and ignores elevated cover', () => {
    const r = road('r', [
      [-400, 0],
      [400, 0],
    ]);
    const ring = (n: number) =>
      [
        [-n, -n],
        [n, -n],
        [n, n],
        [-n, n],
        [-n, -n],
      ].map((p) => projection.unproject(p as [number, number]));
    const building: AtlasFeature = {
      type: 'Feature',
      tippecanoe: { layer: 'buildings', minzoom: 6, maxzoom: 16 },
      properties: { id: 'b', class: 'building', height: 10 },
      geometry: { type: 'Polygon', coordinates: [ring(500), ring(100)] },
    };
    const retained = poles(generateUtilities([r, building], bounds));
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.every((p) => Math.abs(projection.project(p.at)[0]) < 100)).toBe(true);
    building.properties.detail_overhead = true;
    expect(generateUtilities([r, building], bounds).records).toEqual(
      generateUtilities([r], bounds).records,
    );
  });

  it('does not invent links between nearby disconnected roads', () => {
    const result = generateUtilities(
      [
        road('a', [
          [-400, 0],
          [0, 0],
        ]),
        road('b', [
          [10, 0],
          [400, 0],
        ]),
      ],
      bounds,
    );
    expect(result.stats.junctions).toBe(0);
  });

  it('reports an unsafe junction instead of forcing supports into its solid footprint', () => {
    const roads = [
      road('left', [
        [-300, 0],
        [0, 0],
      ]),
      road('right', [
        [0, 0],
        [300, 0],
      ]),
    ];
    const blocked: AtlasFeature = {
      type: 'Feature',
      properties: { id: 'b', class: 'building', height: 10 },
      tippecanoe: { layer: 'buildings', minzoom: 6, maxzoom: 16 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-100, -20],
            [100, -20],
            [100, 20],
            [-100, 20],
            [-100, -20],
          ].map((p) => projection.unproject(p as [number, number])),
        ],
      },
    };
    const result = generateUtilities([...roads, blocked], bounds);
    expect(result.stats.junctions).toBe(0);
    expect(result.stats.continuity.unresolvedGroups).toBe(1);
    expect(result.stats.continuity.unresolved[0]?.reason).toBe('support-distance');
    expect(poles(result).every((p) => Math.abs(projection.project(p.at)[0]) >= 100)).toBe(true);
  });

  it('rejects buffered waterways and the median side of parallel carriageways', () => {
    const r = road('r', [
      [-400, 0],
      [400, 0],
    ]);
    const baseline = poles(generateUtilities([r], bounds));
    const side = baseline.find((p) => !p.partner)!.normal[1];
    const parallel = road(
      'service',
      [
        [-500, side * 12],
        [500, side * 12],
      ],
      'service',
    );
    expect(generateUtilities([r, parallel], bounds).stats.rejected.median).toBeGreaterThan(0);
    const water = road('water', [
      [-500, side * 4.5],
      [500, side * 4.5],
    ]);
    water.properties = { id: 'water', class: 'water_stream', width: 4 };
    expect(generateUtilities([r, water], bounds).stats.rejected.blocked).toBeGreaterThan(0);
  });
});

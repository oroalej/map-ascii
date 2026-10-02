import { describe, expect, it } from 'vitest';
import { onewayOf, sidewalkOf, classify, variantOf } from './classify';
import {
  applyRoadDirections,
  applyRoadExclusions,
  deriveSidewalks,
  onewayArrows,
  streetStats,
} from './streets';
import { mergeTraffic } from './traffic';
import type { AtlasFeature } from '../03-normalize';

const road = (
  id: string,
  coordinates: number[][],
  properties: Partial<AtlasFeature['properties']> = {},
): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: { id, class: 'road_mid', width: 10, ...properties },
  tippecanoe: { layer: 'roads', minzoom: 12, maxzoom: 16 },
});
const cross = () => [
  road('east', [
    [-0.001, 0],
    [0, 0],
    [0.001, 0],
  ]),
  road('north', [
    [0, -0.001],
    [0, 0],
    [0, 0.001],
  ]),
];
const sign = (direction?: 'forward' | 'backward'): AtlasFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: {
    id: 'stop',
    class: 'furniture',
    variant: 'traffic_stop',
    stop_direction: direction,
  },
  tippecanoe: { layer: 'poi', minzoom: 15, maxzoom: 16 },
});
const stops = (features: AtlasFeature[]) =>
  features.filter((f) => f.properties.variant === 'stop_line');
const position = (f: AtlasFeature) => {
  if (f.geometry.type !== 'Point') throw new Error('expected point');
  return f.geometry.coordinates;
};

describe('street tags', () => {
  it('resolves sidewalk presence, precedence, exclusions, and unequal widths', () => {
    expect(sidewalkOf({})).toBeUndefined();
    for (const sidewalk of ['both', 'left', 'right'])
      expect(sidewalkOf({ sidewalk })?.sidewalk).toBe(sidewalk);
    for (const sidewalk of ['no', 'none', 'separate'])
      expect(sidewalkOf({ sidewalk })?.sidewalk).toBe('none');
    expect(sidewalkOf({ sidewalk: 'left', 'sidewalk:both': 'no' })?.sidewalk).toBe('none');
    expect(sidewalkOf({ 'sidewalk:both': 'yes', 'sidewalk:left': 'separate' })?.sidewalk).toBe(
      'right',
    );
    expect(sidewalkOf({ 'sidewalk:left': 'yes' })?.sidewalk).toBe('left');
    expect(
      sidewalkOf({
        sidewalk: 'both',
        'sidewalk:width': '3',
        'sidewalk:both:width': '2.5',
        'sidewalk:left:width': '1.5',
        'sidewalk:right:width': '-1',
      }),
    ).toEqual({ sidewalk: 'both', width: 2.5, leftWidth: 1.5, rightWidth: 2.5 });
  });
  it('resolves explicit and implicit oneway without guessing reversible direction', () => {
    for (const oneway of ['yes', 'true', '1']) expect(onewayOf({ oneway })).toBe(1);
    for (const oneway of ['-1', 'reverse']) expect(onewayOf({ oneway })).toBe(-1);
    for (const oneway of ['reversible', 'alternating', 'no', 'false', '0'])
      expect(onewayOf({ oneway, junction: 'roundabout' })).toBe(0);
    for (const junction of ['roundabout', 'circular']) expect(onewayOf({ junction })).toBe(1);
    expect(onewayOf({})).toBe(0);
    expect(classify({ highway: 'stop' }, 'point', 10)).toBe('furniture');
    expect(variantOf({ highway: 'stop' }, 'furniture')).toBe('traffic_stop');
  });
  it('derives only untagged detail major/mid roads, measuring each sidewalk side', () => {
    const roads = [
      ...cross(),
      road(
        'none',
        [
          [0, 0],
          [0.001, 0],
        ],
        { sidewalk: 'none' },
      ),
      road(
        'region',
        [
          [0, 0],
          [0.001, 0],
        ],
        { region: true },
      ),
      road(
        'minor',
        [
          [0, 0],
          [0.001, 0],
        ],
        { class: 'road_minor' },
      ),
    ];
    const mapped = deriveSidewalks(roads, false);
    expect(mapped).toBe(roads);
    const derived = deriveSidewalks(roads);
    expect(derived.slice(0, 2).every((f) => f.properties.sidewalk_src === 'derived')).toBe(true);
    expect(derived[2]!.properties.sidewalk).toBe('none');
    expect(derived[3]!.properties.sidewalk).toBeUndefined();
    expect(derived[4]!.properties.sidewalk).toBeUndefined();
    expect(streetStats(derived).derivedSidewalkKm).toBeCloseTo(
      streetStats(derived).derivedRoadKm * 2,
    );
  });
});

describe('curated road exclusions', () => {
  const item = { osm_id: 'osm:way/1', source: 'Owner annotated atlas' };
  const target = () =>
    road(
      item.osm_id,
      [
        [0, 0],
        [0.001, 0],
      ],
      { oneway: 1 },
    );

  it('removes the exact road at every level before traffic while preserving neighboring features', () => {
    const removed = target();
    const region = { ...removed, properties: { ...removed.properties, region: true } };
    const neighbor = road(
      'osm:way/2',
      [
        [0, 0],
        [0, 0.001],
      ],
      { oneway: 1 },
    );
    const plaza: AtlasFeature = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [0.001, 0],
            [0, 0.001],
            [0, 0],
          ],
        ],
      },
      properties: { id: 'osm:way/3', class: 'paving' },
      tippecanoe: { layer: 'landuse', minzoom: 12, maxzoom: 16 },
    };
    const features = [removed, region, neighbor, plaza];
    expect(applyRoadExclusions(features, undefined)).toBe(features);
    const filtered = applyRoadExclusions(features, [item]);
    expect(filtered).toEqual([neighbor, plaza]);
    expect(filtered[0]).toBe(neighbor);
    expect(filtered[1]).toBe(plaza);
    expect(features).toHaveLength(4);
    const traffic = mergeTraffic(filtered, { derive: false });
    const arrows = traffic.filter((f) => f.properties.variant === 'oneway_arrow');
    expect(arrows.length).toBeGreaterThan(0);
    expect(
      arrows.every((f) => f.properties.id.startsWith(`${neighbor.properties.id}:oneway:`)),
    ).toBe(true);
    expect(traffic.some((f) => f.properties.id === item.osm_id)).toBe(false);
  });

  it('rejects stale, region-only, non-road, non-line and duplicate targets', () => {
    const f = target();
    expect(() => applyRoadExclusions([], [item])).toThrow('not found');
    expect(() =>
      applyRoadExclusions([{ ...f, properties: { ...f.properties, region: true } }], [item]),
    ).toThrow('not found');
    expect(() =>
      applyRoadExclusions([{ ...f, properties: { ...f.properties, class: 'path' } }], [item]),
    ).toThrow('not a road');
    expect(() =>
      applyRoadExclusions([{ ...f, geometry: { type: 'Point', coordinates: [0, 0] } }], [item]),
    ).toThrow('not a road LineString');
    expect(() => applyRoadExclusions([f], [item, item])).toThrow('Duplicate');
  });
});

describe('curated road directions', () => {
  const source = 'Project owner annotated map';
  it('applies directions before arrows and inbound stop lines without reversing geometry', () => {
    for (const oneway of [-1, 0, 1] as const) {
      const roads = cross();
      const original = roads[0]!;
      original.properties.id = 'osm:way/1';
      original.properties.oneway = 1;
      original.properties.sidewalk = 'left';
      original.properties.sidewalk_left_width = 1.5;
      const result = mergeTraffic(roads, undefined, {
        directions: [{ osm_id: 'osm:way/1', oneway, source }],
        sidewalks: { derive: false, source },
      });
      const changed = result.find((f) => f.properties.id === 'osm:way/1')!;
      expect(changed.geometry).toBe(original.geometry);
      expect(changed.properties).toMatchObject({
        sidewalk: 'left',
        sidewalk_left_width: 1.5,
        oneway_source: source,
      });
      expect(changed.properties.oneway).toBe(oneway || undefined);
      expect(original.properties.oneway).toBe(1);
      expect(result.find((f) => f.properties.id === 'north')).toBe(roads[1]);
      const arrows = result.filter((f) => f.properties.variant === 'oneway_arrow');
      if (!oneway) expect(arrows).toHaveLength(0);
      else {
        expect(arrows.length).toBeGreaterThan(0);
        expect(arrows.every((f) => f.properties.arrow_bearing === (oneway === 1 ? 90 : 270))).toBe(
          true,
        );
        expect(arrows.every((f) => f.properties.source?.includes(source))).toBe(true);
      }
      const horizontal = stops(result).filter((f) =>
        [90, 270].includes(f.properties.stop_bearing!),
      );
      expect(horizontal).toHaveLength(oneway ? 1 : 2);
      expect(horizontal.every((f) => f.properties.stop_width === (oneway ? 10 : 5))).toBe(true);
      if (oneway) expect(horizontal[0]!.properties.stop_bearing).toBe(oneway === 1 ? 90 : 270);
    }
  });

  it('fails loudly for missing, non-road, region-only, and duplicate targets', () => {
    const item = { osm_id: 'osm:way/1', oneway: 0 as const, source };
    const f = road(item.osm_id, [
      [0, 0],
      [0.001, 0],
    ]);
    expect(() => applyRoadDirections([], [item])).toThrow('not found');
    expect(() =>
      applyRoadDirections([{ ...f, properties: { ...f.properties, class: 'path' } }], [item]),
    ).toThrow('not a road');
    expect(() =>
      applyRoadDirections([{ ...f, properties: { ...f.properties, region: true } }], [item]),
    ).toThrow('not found');
    expect(() => applyRoadDirections([f], [item, item])).toThrow('Duplicate');
    const region = { ...f, properties: { ...f.properties, region: true, oneway: 1 as const } };
    expect(applyRoadDirections([f, region], [item])[1]).toBe(region);
  });
});

describe('stop approaches', () => {
  it('marks the four inbound lanes and omits outgoing oneway arms', () => {
    const all = stops(mergeTraffic(cross()));
    expect(all).toHaveLength(4);
    expect(all.map((f) => f.properties.stop_bearing).sort((a, b) => a! - b!)).toEqual([
      0, 90, 180, 270,
    ]);
    for (const f of all) {
      expect(f.properties.stop_width).toBe(5);
      const [x, y] = position(f);
      const theta = (f.properties.stop_bearing! * Math.PI) / 180;
      expect(x! * Math.sin(theta) + y! * Math.cos(theta)).toBeLessThan(0);
    }
    const roads = cross();
    roads[0]!.properties.oneway = 1;
    const lines = stops(mergeTraffic(roads));
    expect(lines).toHaveLength(3);
    const east = lines.find((f) => f.properties.stop_bearing === 90)!;
    expect(east.properties.stop_width).toBe(10);
    expect(position(east)[1]).toBeCloseTo(0, 10);
    expect(lines.some((f) => f.properties.stop_bearing === 270)).toBe(false);
  });
  it('retains directed stops, skips undirected midblock anchors, and prefers mapped junction stops', () => {
    const roadOnly = cross().slice(0, 1);
    for (const [direction, bearing] of [
      ['forward', 90],
      ['backward', 270],
    ] as const) {
      const lines = stops(mergeTraffic([...roadOnly, sign(direction)], { derive: false }));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.properties.stop_bearing).toBe(bearing);
      expect(lines[0]!.properties.stop_src).toBe('mapped');
    }
    let skipped = 0;
    expect(
      stops(
        mergeTraffic([...roadOnly, sign()], undefined, undefined, (s) => {
          skipped = s.undirectedMidblockStops;
        }),
      ),
    ).toHaveLength(0);
    expect(skipped).toBe(1);
    const mixed = stops(mergeTraffic([...cross(), sign('forward')]));
    expect(mixed).toHaveLength(4);
    expect(mixed.filter((f) => f.properties.stop_src === 'mapped')).toHaveLength(1);
  });
  it('uses the lowest-ranked road for undirected junction stops and reports short/unresolved approaches', () => {
    const roads = cross();
    roads[1]!.properties.class = 'road_minor';
    expect(stops(mergeTraffic([...roads, sign()], { derive: false }))).toHaveLength(2);
    let report;
    const tiny = road('tiny', [
      [-0.00001, 0],
      [0, 0],
      [0.00001, 0],
    ]);
    const f: AtlasFeature = { ...sign(), geometry: { type: 'Point', coordinates: [1, 1] } };
    mergeTraffic([tiny, cross()[1]!, sign(), f], { derive: false }, undefined, (stats) => {
      report = stats;
    });
    expect(report).toMatchObject({ unresolvedStops: 1, shortApproaches: 2 });
  });
});

it('bakes stable world-spaced arrows with clearance only from real segment vertices', () => {
  const f = road(
    'oneway',
    [
      [0, 0],
      [0.0009, 0],
    ],
    { oneway: 1 },
  );
  const arrows = onewayArrows([f]);
  const metres = arrows.map((a) => ((position(a)[0]! * Math.PI) / 180) * 6378137);
  expect(metres).toHaveLength(3);
  metres.forEach((x, i) => expect(x).toBeCloseTo((i + 1) * 30, 8));
  expect(onewayArrows([f])).toEqual(arrows);
  // A seam at 58 m must retain the 60 m anchor; it is not an original road vertex.
  expect(metres.filter((x) => x >= 58)[0]).toBeCloseTo(60, 8);
  expect(arrows.every((a) => a.properties.arrow_bearing === 90)).toBe(true);
  const reverse = onewayArrows([{ ...f, properties: { ...f.properties, oneway: -1 } }]);
  expect(reverse.every((a) => a.properties.arrow_bearing === 270)).toBe(true);
  for (const p of metres)
    expect(Math.min(p, ((0.0009 * Math.PI) / 180) * 6378137 - p)).toBeGreaterThanOrEqual(8);
  expect(
    onewayArrows([
      road(
        'short',
        [
          [0, 0],
          [0.0001, 0],
        ],
        { oneway: 1 },
      ),
    ]),
  ).toEqual([]);
});

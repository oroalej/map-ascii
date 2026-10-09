import { describe, expect, it } from 'vitest';
import {
  buildTileGeometry,
  createIdRegistry,
  hashString,
  tileToLngLat,
  type TileFeatureLike,
} from '../raster/geometry';
import { lifeTransferables } from './geometry';
import { TileLife } from './simulate';
import {
  peddlerConfig,
  peddlerFixture,
  peddlerTile as tile,
  peddlerWeather,
} from './testing/peddlers';

const feature = (
  type: TileFeatureLike['type'],
  properties: TileFeatureLike['properties'],
  rings: { x: number; y: number }[][],
): TileFeatureLike => ({ type, properties, loadGeometry: () => rings });
const line = [
  { x: 200, y: 1800 },
  { x: 3800, y: 1800 },
];
const ring = [
  { x: 100, y: 1600 },
  { x: 3900, y: 1600 },
  { x: 3900, y: 2000 },
  { x: 100, y: 2000 },
  { x: 100, y: 1600 },
];
const decode = (features: TileFeatureLike[]) =>
  buildTileGeometry(
    {
      map: {
        extent: 4096,
        length: features.length,
        feature: (i) => features[i]!,
      },
    },
    createIdRegistry(),
    tile,
    16,
  ).life;
const path = (restricted = false) =>
  feature(
    2,
    {
      id: 'path',
      class: 'path',
      kind: 'highway=footway',
      ...(restricted && { vendor_restricted: true }),
    },
    [line],
  );
const peddlers = (geo: ReturnType<typeof decode>) => {
  const { population } = peddlerFixture([{ ...peddlerConfig, lines: ['path'], share: 1 }], geo);
  population.step(0, peddlerWeather, 0);
  return population.owners;
};

const privateGroundTags: TileFeatureLike['properties'][] = [
  { vendor_restricted: true },
  { access: 'private', foot: 'yes' },
  { ownership: 'private', access: 'public' },
];
describe('vendors outside private property', () => {
  it.each(privateGroundTags)(
    'excludes private lawns using %j without excluding ordinary walkers',
    (tags) => {
      const publicGround = decode([path(), feature(3, { class: 'grass', id: 'lawn' }, [ring])]);
      expect(new TileLife(tile, publicGround, 3).stalls.length).toBeGreaterThan(0);
      expect(peddlers(publicGround).length).toBeGreaterThan(0);
      const privateGround = decode([
        path(),
        feature(3, { class: 'grass', id: 'lawn', ...tags }, [ring]),
      ]);
      const ordinary = new TileLife(tile, publicGround, 3),
        restricted = new TileLife(tile, privateGround, 3);
      expect(restricted.stalls).toHaveLength(0);
      expect(peddlers(privateGround)).toHaveLength(0);
      expect(restricted.movers).toEqual(ordinary.movers);
    },
  );
  it('preserves private path restrictions through worker cloning for both vendor populations', () => {
    expect(peddlers(decode([path()])).length).toBeGreaterThan(0);
    const geo = decode([path(true)]);
    const copy = structuredClone(geo, { transfer: lifeTransferables(geo) });
    expect(copy.vendorRestrictedLineIds).toEqual([hashString('path') >>> 0]);
    expect(new TileLife(tile, copy, 3).stalls).toHaveLength(0);
    expect(peddlers(copy)).toHaveLength(0);
  });
  it('carries a private street restriction onto both of its mapped sidewalks', () => {
    const geo = decode([
      feature(
        2,
        {
          id: 'road',
          class: 'road_minor',
          kind: 'highway=residential',
          width: 6,
          sidewalk: 'both',
          vendor_restricted: true,
        },
        [line],
      ),
    ]);
    expect(geo.vendorRestrictedLineIds).toEqual(
      expect.arrayContaining([
        hashString('road') >>> 0,
        hashString('road/sidewalk-left') >>> 0,
        hashString('road/sidewalk-right') >>> 0,
      ]),
    );
    expect(geo.peddlerStreetIds).toEqual([]);
    expect(new TileLife(tile, geo, 3).stalls).toHaveLength(0);
    expect(peddlers(geo)).toHaveLength(0);
  });
  it('rejects later commerce and seasonal carts on private walking routes', () => {
    const build = (restricted: boolean) => {
      const geo = decode([path(restricted)]);
      geo.commerce = Float32Array.from(
        Array.from({ length: 20 }, (_, i) => [400 + i * 150, 1800]).flat(),
      );
      const life = new TileLife(tile, geo, 3);
      life.admitCommerce(() => true);
      life.admitSeasonalStalls(
        { near: ['worship'], radius_m: 1000, per_tile: 8 },
        [{ kind: 'worship', at: tileToLngLat(tile, { x: 1800, y: 1800 }) }],
        () => true,
      );
      return life;
    };
    const publicRoute = build(false),
      privateRoute = build(true);
    expect(publicRoute.stalls.length).toBeGreaterThan(0);
    expect(publicRoute.seasonalStalls.length).toBeGreaterThan(0);
    expect(privateRoute.stalls).toHaveLength(0);
    expect(privateRoute.seasonalStalls).toHaveLength(0);
  });
  it.each(['fence', 'wall', 'hedge'])('excludes grounds enclosed by a mapped %s', (kind) => {
    const geo = decode([
      path(),
      feature(2, { class: 'barrier', id: 'boundary', kind: `barrier=${kind}` }, [ring]),
    ]);
    expect(new TileLife(tile, geo, 3).stalls).toHaveLength(0);
    expect(peddlers(geo)).toHaveLength(0);
    const open = decode([
      path(),
      feature(2, { class: 'barrier', id: 'open', kind: `barrier=${kind}` }, [ring.slice(0, 3)]),
    ]);
    expect(open.areas?.some((a) => a.kind === 'peddler-exclusion')).toBe(false);
  });
});

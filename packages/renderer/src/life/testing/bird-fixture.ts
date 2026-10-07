import { metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { metersPerCssPx } from '../../grid';
import { Habitat, type BirdSpecies } from '../birds';
import { LifeBuilder } from '../geometry';
import { LifeWorld, type LifeEnv } from '../simulate';

export const birdTile = { z: 16, x: 55192, y: 30266 };
export const birdPerMeter = 1 / metersPerUnit(birdTile);
export const birdPoint = (x: number, y: number) => ({
  x: 2048 + x * birdPerMeter,
  y: 2048 + y * birdPerMeter,
});
export const birdLngLat = (x: number, y: number) => tileToLngLat(birdTile, birdPoint(x, y));

/** A real seeded tile with one flock and no unrelated actors. */
export function birdFixture(
  species: BirdSpecies = 'pigeon',
  options: {
    roost?: boolean;
    perch?: boolean;
    water?: boolean;
    observer?: boolean;
    inspection?: boolean;
  } = {},
) {
  const builder = new LifeBuilder();
  if (options.water)
    builder.area('water', [
      [
        birdPoint(-100, -100),
        birdPoint(100, -100),
        birdPoint(100, 0),
        birdPoint(-100, 0),
        birdPoint(-100, -100),
      ],
    ]);
  if (options.roost !== false)
    builder.roost(birdPoint(0, 0), options.water ? Habitat.water : Habitat.park);
  if (options.perch !== false) builder.perch(birdPoint(50, 0));
  const entry = { key: 'bird-fixture', tile: birdTile, life: builder.finish() };
  const world = new LifeWorld(
    undefined,
    undefined,
    undefined,
    options.inspection,
    options.observer,
  );
  world.sync([entry]);
  const life = world.resident(entry.key)!;
  const flock = life.flocks[0]!;
  life.flocks.splice(1);
  life.movers.length = life.gatherers.length = life.stalls.length = life.parked.length = 0;
  flock.birds.splice(1);
  Object.assign(flock, birdPoint(20, 0), {
    species,
    rank: 0,
    stay: 1000,
    radius: 20 * birdPerMeter,
    angle: 0,
    hx: 1,
    hy: 0,
    perch: -1,
    perched: false,
    landed: false,
    landing: false,
  });
  Object.assign(flock.birds[0]!, { ox: 2 * birdPerMeter, oy: 0, phase: 0 });
  const center = birdLngLat(0, 0);
  const cellMeters = (zoom: number) =>
    metersPerCssPx({ lng: center[0], lat: center[1], zoom }) * (zoom < 15 ? 7 : 5);
  const step = (
    pointer?: readonly [number, number],
    dt = 0.1,
    zoom = 19,
    weather: Partial<LifeEnv> = {},
    gust?: (lng: number, lat: number) => number,
  ) => {
    world.setEmojiView([zoom, 1, center]);
    world.step(
      dt,
      gust,
      zoom,
      undefined,
      undefined,
      { rain: 0, ...weather },
      cellMeters(zoom),
      1.8,
      cellMeters(zoom),
      pointer,
    );
  };
  const visible = (zoom = 19, maxAgents = 1200) =>
    world
      .visible(zoom, 1, center, undefined, undefined, 1, maxAgents)
      .filter((a) => a.kind === 'bird');
  return { world, life, flock, entry, center, cellMeters, step, visible };
}

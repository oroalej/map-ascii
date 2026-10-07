import { describe, expect, it, vi } from 'vitest';
import { birdFixture, birdPoint, birdLngLat, birdPerMeter, birdTile } from './testing/bird-fixture';
import { BIRD_POINTER, PERCH } from './config';
import { BIRD_SPECIES } from './birds';
import { lngLatToTile } from '../raster/geometry';
import { type Flock } from './simulate';

type Fixture = ReturnType<typeof birdFixture>;
const reach = (f: Fixture, zoom: number) =>
  Math.max(BIRD_SPECIES[f.flock.species].wary, BIRD_POINTER.cells * f.cellMeters(zoom));
function checkClear(f: Fixture, pointer: readonly [number, number], zoom: number) {
  const p = lngLatToTile(birdTile, ...pointer);
  const views = f.visible(zoom);
  expect(views.length).toBeGreaterThan(0);
  for (const view of views) {
    const at = lngLatToTile(birdTile, view.lng, view.lat);
    expect(Math.hypot(at.x - p.x, at.y - p.y) / birdPerMeter).toBeGreaterThanOrEqual(
      reach(f, zoom) - 1e-5,
    );
  }
}

describe('birds keep clear of the mouse', () => {
  it('reuses the rendered extent across an unchanged target-flight layout', () => {
    const f = birdFixture();
    f.flock.perch = 0;
    const extent = vi.spyOn(
      f.life as unknown as { flockExtent(flock: Flock): number },
      'flockExtent',
    );
    f.step(birdLngLat(25, 0));
    expect(extent).toHaveBeenCalledTimes(1);
  });
  it('passes around a resting pointer on the way to a clear perch', () => {
    const f = birdFixture();
    Object.assign(f.flock, birdPoint(0, 0), { perch: 0 });
    const pointer = birdLngLat(25, 0);
    for (let i = 0; i < 200 && !f.flock.perched; i++) {
      f.step(pointer);
      checkClear(f, pointer, 19);
    }
    expect(f.flock.perched).toBe(true);
  });
  it.each([false, true])(
    'flushes a perched flock only inside its rendered clearance (inside=%s)',
    (inside) => {
      const f = birdFixture();
      Object.assign(f.flock, birdPoint(50, 0), { perched: true, perch: 0 });
      const radius = reach(f, 19) + (2 * PERCH.spread) / BIRD_SPECIES.pigeon.spread[1];
      f.step(birdLngLat(50 + radius + (inside ? -0.01 : 0.01), 0));
      expect(f.flock.perched).toBe(!inside);
      if (inside) {
        expect(f.flock.scatter).toBe(PERCH.scatter);
        expect(f.flock.perch).toBe(-1);
      }
    },
  );

  it('flushes a ground-foraging egret and preserves every bird identity', () => {
    const f = birdFixture('egret', { water: true });
    Object.assign(f.flock, birdPoint(0, 1), {
      landed: true,
      feeding: true,
      home: 0,
      lx: birdPoint(0, 1).x,
      ly: birdPoint(0, 1).y,
    });
    Object.assign(f.flock.birds[0]!, { gx: 0, gy: 0, tx: 0, ty: 0, face: 0, wait: 0 });
    const birds = [...f.flock.birds];
    f.step(birdLngLat(0, 1));
    expect(f.flock.landed).toBe(false);
    expect(f.flock.feeding).toBe(false);
    expect(f.flock.home).toBe(-1);
    expect(f.flock.birds).toEqual(birds);
    f.flock.birds.forEach((bird, i) => expect(bird).toBe(birds[i]));
  });

  it.each([18, 14])('keeps all circling swallow views clear for 30 seconds at z%s', (zoom) => {
    const f = birdFixture('swallow', { perch: false });
    const pointer = birdLngLat(20, 0);
    const warmup =
      zoom === 18
        ? 1
        : 2 +
          (reach(f, zoom) + 4 * BIRD_SPECIES.swallow.spread[1]) /
            (BIRD_SPECIES.swallow.speed * 1.4 * (BIRD_POINTER.flee - 1));
    for (let frame = 0; frame < Math.ceil(warmup * 30); frame++) f.step(pointer, 1 / 30, zoom);
    for (let frame = 0; frame < 30 * 30; frame++) {
      f.step(pointer, 1 / 30, zoom);
      checkClear(f, pointer, zoom);
    }
    expect(f.flock.scatter).toBe(0);
  });

  it('points directly away during a correction and handles an exact-centre pointer', () => {
    const f = birdFixture('swallow', { roost: false });
    const before = { x: f.flock.x, y: f.flock.y };
    f.step(birdLngLat(20, 0));
    expect(f.flock.x - before.x).toBeGreaterThan(0);
    expect(f.flock.hy).toBeCloseTo(0);
    expect(Math.hypot(f.flock.hx, f.flock.hy)).toBeCloseTo(1);
  });

  it('moves a flushed tree-only flock clear and lets it settle after the pointer leaves', () => {
    const f = birdFixture('pigeon', { roost: false });
    Object.assign(f.flock, birdPoint(50, 0), { perched: true, perch: 0 });
    const pointer = birdLngLat(50, 0);
    f.step(pointer);
    for (let i = 0; i < 30; i++) f.step(pointer);
    checkClear(f, pointer, 19);
    f.flock.stay = 0;
    for (let i = 0; i < 100 && !f.flock.perched; i++) f.step();
    expect(f.flock.perched).toBe(true);
  });

  it('cancels a destination beside the pointer even with a distant flock centre', () => {
    const f = birdFixture();
    Object.assign(f.flock, birdPoint(-100, 0), { perch: 0 });
    const pointer = birdLngLat(50, 0);
    for (let i = 0; i < 200; i++) {
      f.step(pointer);
      expect(f.flock.perched).toBe(false);
      expect(f.flock.perch).toBe(-1);
    }
    f.flock.perch = 0;
    for (let i = 0; i < 200 && !f.flock.perched; i++) f.step();
    expect(f.flock.perched).toBe(true);
  });

  it.each(['landing', 'departure'] as const)(
    'includes %s-blended positions in clearance',
    (layout) => {
      const f = birdFixture('egret', { water: true, perch: false });
      Object.assign(f.flock, birdPoint(0, 1));
      const bird = f.flock.birds[0]!;
      Object.assign(bird, {
        gx: 10 * birdPerMeter,
        gy: 0,
        tx: 10 * birdPerMeter,
        ty: 0,
        face: 0,
        wait: 100,
      });
      if (layout === 'landing')
        Object.assign(f.flock, {
          landing: true,
          landingBlend: 0.9,
          lx: birdPoint(40, 1).x,
          ly: birdPoint(40, 1).y,
        });
      else {
        bird.departure = { x: 10 * birdPerMeter, y: 0 };
        f.flock.departureBlend = 0.9;
      }
      const extent = f.life as unknown as { flockExtent(flock: Flock): number };
      const at = lngLatToTile(birdTile, f.visible()[0]!.lng, f.visible()[0]!.lat);
      expect(extent.flockExtent(f.flock)).toBeCloseTo(
        Math.hypot(at.x - f.flock.x, at.y - f.flock.y),
        5,
      );
      const pointer = birdLngLat(12, 1);
      const before = f.flock.x;
      f.step(pointer);
      expect(f.flock.x).toBeLessThan(before);
      for (let i = 0; i < 40; i++) f.step(pointer);
      checkClear(f, pointer, 19);
    },
  );

  it('keeps ground landing attempts bounded under rain and a sustained pointer', () => {
    const f = birdFixture('pigeon', { perch: false });
    const picks = vi.spyOn(
      f.life as unknown as { pickDestination(flock: Flock): void },
      'pickDestination',
    );
    for (let i = 0; i < 600; i++) f.step(birdLngLat(0, 0), 0.1, 19, { rain: 1 });
    expect(f.life.forageChecks).toBeLessThan(1000);
    expect(picks.mock.calls.length).toBeLessThan(60);
  });

  it('does no extent work without a pointer or outside the coarse bound', () => {
    const f = birdFixture();
    const extent = vi.spyOn(
      f.life as unknown as { flockExtent(flock: Flock): number },
      'flockExtent',
    );
    for (let i = 0; i < 10; i++) f.step();
    expect(extent).not.toHaveBeenCalled();
    f.step(birdLngLat(-200, -200));
    expect(extent).not.toHaveBeenCalled();
  });
});

type Legacy = 'perched' | 'ground' | 'circling' | 'rain' | 'gust' | 'nocturnal';
function legacy(kind: Legacy, explicit = false) {
  const f = birdFixture(kind === 'nocturnal' ? 'bat' : 'pigeon');
  if (kind === 'perched' || kind === 'rain' || kind === 'gust')
    Object.assign(f.flock, birdPoint(50, 0), { perch: 0, perched: true });
  if (kind === 'ground') {
    Object.assign(f.flock, birdPoint(0, 0), {
      landed: true,
      feeding: true,
      lx: birdPoint(0, 0).x,
      ly: birdPoint(0, 0).y,
      bout: 100,
    });
    Object.assign(f.flock.birds[0]!, { gx: 0, gy: 0, tx: 0, ty: 0, face: 0, wait: 0 });
  }
  for (let frame = 0; frame < 40; frame++) {
    if (frame === 20) f.flock.stay = 0;
    const args = [
      0.1,
      kind === 'gust' && frame === 0 ? () => 1 : undefined,
      19,
      undefined,
      undefined,
      { rain: kind === 'rain' ? 1 : 0 },
      0.9,
      1.8,
      0.9,
    ] as const;
    if (explicit) f.world.step(...args, undefined);
    else f.world.step(...args);
  }
  const state = structuredClone(f.life.flocks);
  if (!explicit) expect(state).toEqual(legacy(kind, true));
  return state;
}

describe('legacy flock states without a pointer (base 6645425)', () => {
  it('preserves perched departures', () => {
    expect(legacy('perched')).toMatchInlineSnapshot(`
      [
        {
          "angle": 0.8550000000000002,
          "birds": [
            {
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
            },
          ],
          "bout": 0,
          "feeding": false,
          "home": -1,
          "hx": -0.871061232552699,
          "hy": 0.49117443860992305,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": NaN,
          "ly": NaN,
          "perch": -1,
          "perched": false,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "pigeon",
          "stay": 25.28841597437856,
          "x": 2236.9298998353074,
          "y": 2096.4783593507627,
        },
      ]
    `);
  });
  it('preserves ground feeding and destination transitions', () => {
    expect(legacy('ground')).toMatchInlineSnapshot(`
      [
        {
          "angle": 0.8550000000000002,
          "birds": [
            {
              "departure": {
                "x": 1.2434497875801753e-13,
                "y": -7.582823258189819e-14,
              },
              "face": -1.4602127024250213,
              "gx": 1.2380374503351277e-13,
              "gy": -7.582823258189819e-14,
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
              "tx": 0.33752443080902594,
              "ty": -3.0397581663776236,
              "wait": -0.014525142125785234,
            },
          ],
          "bout": 98.00000000000011,
          "departureBlend": 0,
          "feeding": false,
          "home": -1,
          "hx": -0.47278242039539264,
          "hy": 0.8811792002567208,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": 2048,
          "ly": 2048,
          "perch": -1,
          "perched": false,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "pigeon",
          "stay": 25.28841597437856,
          "x": 2142.8607568829357,
          "y": 2143.790564958033,
        },
      ]
    `);
  });
  it('preserves circling and destinations', () => {
    expect(legacy('circling')).toMatchInlineSnapshot(`
      [
        {
          "angle": 1.7999999999999992,
          "birds": [
            {
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
            },
          ],
          "bout": 0,
          "feeding": false,
          "home": -1,
          "hx": -0.9787127519084315,
          "hy": -0.20523486363633497,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": NaN,
          "ly": NaN,
          "perch": -1,
          "perched": false,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "pigeon",
          "stay": 25.28841597437856,
          "x": 2016.6829850322688,
          "y": 2182.2329210199405,
        },
      ]
    `);
  });
  it('preserves rain shelter', () => {
    expect(legacy('rain')).toMatchInlineSnapshot(`
      [
        {
          "angle": 0,
          "birds": [
            {
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
            },
          ],
          "bout": 0,
          "feeding": false,
          "home": -1,
          "hx": 1,
          "hy": 0,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": NaN,
          "ly": NaN,
          "perch": 0,
          "perched": true,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "pigeon",
          "stay": 0,
          "x": 2392.5942588033304,
          "y": 2048,
        },
      ]
    `);
  });
  it('preserves gust flushes', () => {
    expect(legacy('gust')).toMatchInlineSnapshot(`
      [
        {
          "angle": 1.7549999999999992,
          "birds": [
            {
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
            },
          ],
          "bout": 0,
          "feeding": false,
          "home": -1,
          "hx": -0.9753411196722954,
          "hy": 0.22070274188689476,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": NaN,
          "ly": NaN,
          "perch": -1,
          "perched": false,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "pigeon",
          "stay": 25.74403340406713,
          "x": 2080.6977297328604,
          "y": 2170.3939677557696,
        },
      ]
    `);
  });
  it('preserves nocturnal flight', () => {
    expect(legacy('nocturnal')).toMatchInlineSnapshot(`
      [
        {
          "angle": 2.000000000000001,
          "birds": [
            {
              "ox": 13.783770352133219,
              "oy": 0,
              "phase": 0,
            },
          ],
          "bout": 0,
          "feeding": false,
          "home": -1,
          "hx": -0.5419322772359184,
          "hy": -0.8404221599231493,
          "landed": false,
          "landing": false,
          "landingAttempted": false,
          "landingBlend": 0,
          "lx": NaN,
          "ly": NaN,
          "perch": -1,
          "perched": false,
          "radius": 137.8377035213322,
          "rank": 0,
          "roost": 0,
          "scatter": 0,
          "species": "bat",
          "stay": 25.28841597437856,
          "x": 1998.8498668269765,
          "y": 2200.2313736656374,
        },
      ]
    `);
  });
});

describe('pointer fear delivery and lifecycle', () => {
  const sitting = (observer = true) => {
    const f = birdFixture('pigeon', { observer });
    Object.assign(f.flock, birdPoint(50, 0), { perched: true, perch: 0 });
    return f;
  };
  const cued = () => {
    const f = sitting();
    f.flock.birds.push({ ...f.flock.birds[0]! });
    f.step(birdLngLat(50, 0));
    for (let i = 0; i < 5; i++) f.step();
    return f;
  };
  it('queues the physical flush until the next frame and gives only one bird a fear cue', () => {
    const f = sitting();
    f.flock.birds.push({ ...f.flock.birds[0]! });
    f.step(birdLngLat(50, 0));
    expect(f.flock.perched).toBe(false);
    expect(f.life.startled).toEqual([f.flock]);
    expect(f.visible().some((a) => a.emoji)).toBe(false);
    f.step();
    expect(f.life.startled).toHaveLength(0);
    expect(f.life.birdEmojiOwners.has(f.flock)).toBe(true);
    for (let i = 0; i < 4; i++) f.step();
    expect(f.visible().filter((a) => a.emoji)).toHaveLength(1);
    expect(f.visible().find((a) => a.emoji)!.emoji).toMatchObject({
      subject: 'bird',
      mood: 'scared',
    });
    for (let i = 0; i < 30; i++) f.step();
    expect(f.life.birdEmojiOwners.size).toBe(0);
    const idle = sitting();
    for (let i = 0; i < 10; i++) idle.step();
    expect(idle.visible().some((a) => a.emoji)).toBe(false);
    expect(idle.life.birdEmojiOwners.size).toBe(0);
  });
  it.each([undefined, 13])(
    'resets flying onset on pointer-free accepted frames, including bird-suppressed zoom %s',
    (zoom) => {
      const f = birdFixture('swallow', { roost: false });
      const at = () =>
        birdLngLat((f.flock.x - 2048) / birdPerMeter, (f.flock.y - 2048) / birdPerMeter);
      f.step(at());
      expect(f.life.startled).toEqual([f.flock]);
      for (let i = 0; i < 460; i++) f.step(undefined, 0.1, zoom ?? 19);
      f.step(at());
      expect(f.life.startled).toEqual([f.flock]);
      for (let i = 0; i < 6; i++) f.step();
      expect(f.visible().some((a) => a.emoji?.mood === 'scared')).toBe(true);
    },
  );
  it('drops z17 events and a queued event suppressed before delivery', () => {
    for (const queued of [false, true]) {
      const f = sitting();
      if (queued) f.step(birdLngLat(50, 0));
      f.step(queued ? undefined : birdLngLat(50, 0), 0.1, 17);
      expect(f.flock.perched).toBe(false);
      expect(f.life.startled).toHaveLength(0);
      expect(f.life.birdEmojiOwners.size).toBe(0);
      for (let i = 0; i < 6; i++) f.step();
      expect(f.visible().some((a) => a.emoji)).toBe(false);
    }
  });
  it('keeps disabled observation collections empty while physical pointer reactions continue', () => {
    const f = sitting(false);
    for (let i = 0; i < 50; i++) {
      f.step(birdLngLat(50, 0));
      expect(f.life.startled).toHaveLength(0);
      expect(f.life.birdEmojiOwners.size).toBe(0);
    }
    expect(f.flock.perched).toBe(false);
    expect(f.visible().some((a) => a.emoji)).toBe(false);
  });
  it('drops undelivered events on retirement, while pending and active cues freeze through revival', () => {
    for (const delivery of ['raw', 'pending', 'active'] as const) {
      const f = sitting();
      f.step(birdLngLat(50, 0));
      if (delivery !== 'raw') f.step();
      if (delivery === 'active') for (let i = 0; i < 4; i++) f.step();
      const cue = f.life.emoji.cue(f.flock);
      f.world.sync([]);
      expect(f.life.startled).toHaveLength(0);
      for (let i = 0; i < 20; i++) f.step();
      f.world.sync([f.entry]);
      for (let i = 0; i < 5; i++) f.step();
      if (delivery === 'raw') expect(f.visible().some((a) => a.emoji)).toBe(false);
      else {
        expect(f.visible().find((a) => a.emoji)?.emoji?.mood).toBe('scared');
        if (cue) expect(f.life.emoji.cue(f.flock)?.id).toBe(cue.id);
      }
    }
  });
  it('anchors fear to the admitted bird when the first pushed bird is capped out', () => {
    const f = cued();
    Object.assign(f.flock, birdPoint(0, 0), { perched: true });
    Object.assign(f.flock.birds[0]!, { ox: 100 * birdPerMeter, oy: 0, phase: 0 });
    Object.assign(f.flock.birds[1]!, { ox: 0, oy: 0, phase: 0 });
    const views = f.visible();
    const kept = f.visible(19, 1);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.lng).toBe(views[1]!.lng);
    expect(kept[0]!.emoji?.mood).toBe('scared');
  });
  it('prefers an admitted in-view bird over an off-view first bird', () => {
    const f = cued();
    Object.assign(f.flock, birdPoint(0, 0), { perched: true });
    Object.assign(f.flock.birds[0]!, { ox: -100 * birdPerMeter, oy: 0, phase: 0 });
    Object.assign(f.flock.birds[1]!, { ox: 0, oy: 0, phase: 0 });
    const a = birdLngLat(-1, 1),
      b = birdLngLat(1, -1);
    const views = f.world.visible(19, 1, f.center, undefined, [a[0], a[1], b[0], b[1]]);
    expect(views.filter((v) => v.emoji)).toHaveLength(1);
    expect(views[0]!.emoji).toBeUndefined();
    expect(views[1]!.emoji?.mood).toBe('scared');
  });
});

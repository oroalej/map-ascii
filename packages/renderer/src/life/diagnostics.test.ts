import { expect, it } from 'vitest';
import { FrameProfiler, PROFILE_CAPACITY } from '../profile';
import { makeScenario, completeScenarioState } from './testing/scenarios';

it('keeps weak origin/incarnation/ordinal identities and a bounded chosen-traveler trace', () => {
  const p = new FrameProfiler(() => 0);
  const a = {},
    b = {},
    c = {};
  p.registerPopulation('tile', [a, b]);
  p.registerPopulation('tile', [c]);
  expect(p.identity(a)).toBe('tile#1:0');
  expect(p.identity(b)).toBe('tile#1:1');
  expect(p.identity(c)).toBe('tile#2:0');
  p.observeVisible(a, true);
  for (let i = 0; i < PROFILE_CAPACITY + 5; i++) {
    p.begin(i);
    p.countContinuity('attempts');
    p.traceTraveler(a, { at: i, tile: 'new-owner', event: 'step', lng: i, lat: 0 });
    p.traceTraveler(b, { at: i, tile: 'tile', event: 'step', lng: 0, lat: 0 });
    p.end();
  }
  const report = p.snapshot();
  expect(report.continuity.trace).toHaveLength(PROFILE_CAPACITY);
  expect(report.continuity.trace.every((t) => t.id === 'tile#1:0')).toBe(true);
  report.continuity.trace[0]!.lng = -1;
  expect(p.snapshot().continuity.trace[0]!.lng).toBe(5);
  p.countContinuity('transfers');
  p.reset();
  p.begin(0);
  p.end();
  expect(p.snapshot().continuity).toEqual({ counts: {}, trace: [] });
});

it('profiling preserves complete simulation state and worker delta counts are merged once', () => {
  const p = new FrameProfiler(() => 0);
  const plain = makeScenario('junction', 1);
  const profiled = makeScenario('junction', 1, false, 1, undefined, p);
  for (let frame = 0; frame < 60; frame++) {
    p.begin(frame);
    expect(profiled.step(frame)).toEqual(plain.step(frame));
    p.end();
  }
  expect(completeScenarioState(profiled.world)).toEqual(completeScenarioState(plain.world));
  expect(p.snapshot().continuity.trace.length).toBeGreaterThan(0);
  const worker = new FrameProfiler(() => 0),
    main = new FrameProfiler(() => 0);
  worker.countContinuity('transfers', 3);
  worker.begin(1);
  const delta = worker.drain()!;
  expect(worker.drain()).toBeUndefined();
  main.merge(delta);
  main.begin(2);
  main.end();
  expect(main.snapshot().continuity.counts.transfers).toBe(3);
  profiled.world.clearTiles();
  expect(p.snapshot().continuity).toEqual({ counts: {}, trace: [] });
});

it('honors explicit selection, restores automatic selection and clears it on reset', () => {
  const profile = new FrameProfiler(() => 0),
    a = {},
    b = {};
  profile.registerPopulation('tile', [a, b]);
  profile.selectTraveler(profile.identity(b));
  profile.observeVisible(a, true);
  expect(profile.tracing(a)).toBe(false);
  expect(profile.tracing(b)).toBe(true);
  profile.selectTraveler();
  profile.observeVisible(a, true);
  expect(profile.tracing(a)).toBe(true);
  profile.reset();
  expect(profile.tracing(a)).toBe(false);
  profile.observeVisible(b, true);
  expect(profile.tracing(b)).toBe(true);
});

import { expect, it } from 'vitest';
import {
  classMask,
  focusHighlights,
  lifeFocusOf,
  normalizeFocus,
  LIFE_FOCUS_BIT,
  focusPulse,
} from './focus';
import { featureInfo } from './raster/geometry';
import { LIFE_AGENT_MASK, TURN_SIGNAL_BIT } from './life/turn-signals';
import { CellBit } from './life/config';
import { legendEntries } from './legend';
import type { VisibleAgent } from './life/simulate';

it('keeps Life permissions separate from focus, indicators and static fixture bits', () => {
  expect(LIFE_AGENT_MASK).toBe(79);
  expect(LIFE_AGENT_MASK & LIFE_FOCUS_BIT).toBe(0);
  expect(LIFE_AGENT_MASK & TURN_SIGNAL_BIT).toBe(0);
  expect(LIFE_AGENT_MASK & CellBit.streetlight).toBe(0);
});

it('packs ids 31, 32 and 63 in unsigned words and excludes invalid/empty ids', () => {
  expect([...classMask([0, -1, 31, 32, 63, 64, 1.5])]).toEqual([0x80000000, 0x80000001]);
  const input = { classes: ['road_mid' as const], life: ['vendors' as const] };
  const result = normalizeFocus(input);
  input.life.length = 0;
  expect([...result.life]).toEqual(['vendors']);
  expect(normalizeFocus(null).key).toBe(normalizeFocus({ classes: [], life: [] }).key);
});
it('distinguishes folklore focus and matches the shared shader pulse with motion gates', () => {
  const folklore = normalizeFocus({ classes: [], life: [], folklore: true });
  expect(folklore.folklore).toBe(true);
  expect(folklore.key).not.toBe(normalizeFocus(null).key);
  expect(normalizeFocus(null).folklore).toBe(false);
  expect(focusPulse(0, true)).toBe(0.75);
  expect(focusPulse(Math.PI / 6, true)).toBe(1);
  expect(focusPulse(Math.PI / 2, true)).toBe(0.5);
  expect(focusPulse(0, false)).toBe(1);
});
it('separates vendor attendants, pets, paddlers and carabao from their drawing classes', () => {
  const base: VisibleAgent = { kind: 'person', lng: 0, lat: 0, flap: 0 };
  expect(lifeFocusOf({ ...base, vehicle: 'cart' })).toBe('vendors');
  expect(lifeFocusOf({ ...base, vehicle: 'carabao' })).toBe('traffic');
  expect(lifeFocusOf({ ...base, aboard: true })).toBe('people');
  expect(lifeFocusOf({ ...base, kind: 'dog' })).toBe('pets');
  expect(lifeFocusOf({ ...base, kind: 'cat' })).toBe('pets');
  expect(lifeFocusOf({ ...base, kind: 'bird' })).toBe('birds');
  expect(lifeFocusOf({ ...base, line: { points: [], paints: [] } })).toBe('boats');
});
it('adds descriptors after class merging and keeps hardware and fish ineligible', () => {
  const entries = legendEntries('dark', 20, undefined, {
    life: true,
    lights: true,
    fixtures: { streetlights: true, trafficSignals: true, utilities: true },
  });
  const school = entries.find((entry) => entry.classes.includes('building_school'))!;
  expect(school.focus?.classes).toContain('marker_school');
  expect(school.focus?.classes).toContain('building_school');
  expect(entries.find((entry) => entry.label.startsWith('Street vendors'))?.focus?.life).toEqual([
    'vendors',
  ]);
  expect(entries.find((entry) => entry.label.startsWith('Cats and dogs'))?.focus?.life).toEqual([
    'pets',
  ]);
  for (const entry of entries.filter(
    (entry) =>
      !entry.classes.length &&
      !entry.label.startsWith('Street vendors') &&
      !entry.label.startsWith('Cats and dogs'),
  ))
    expect(entry.focus, entry.label).toBeUndefined();
  expect(
    legendEntries('dark', 20, undefined, { life: false }).some((entry) => entry.focus?.life.length),
  ).toBe(false);
});

it('lights curated landmark and heritage footprints as focus members, clearing tour highlights', () => {
  const features = { heritage: [4, 9], notable: [2, 4, 9] };
  expect(focusHighlights(normalizeFocus(null), features)).toBeNull();
  const heritage = normalizeFocus({ classes: ['marker_heritage'], life: [] });
  expect(focusHighlights(heritage, features)).toBe(features.heritage);
  const landmark = normalizeFocus({ classes: ['marker_landmark', 'marker_heritage'], life: [] });
  expect(focusHighlights(landmark, features)).toBe(features.notable);
  expect(focusHighlights(normalizeFocus({ classes: ['building'], life: [] }), features)).toEqual(
    [],
  );
  expect(focusHighlights(normalizeFocus({ classes: [], life: ['people'] }), features)).toEqual([]);
  const info = featureInfo('osm:way/1', 'building', { heritage: true, notable: true });
  expect(info).toMatchObject({ heritage: true, notable: true });
  expect(featureInfo('osm:way/2', 'building', { landmark: true })).not.toHaveProperty('notable');
});

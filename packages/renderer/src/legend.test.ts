import { describe, expect, it } from 'vitest';
import { legendEntries } from './legend';
import { DOG_ICON, dogPixels } from './life/dogs';
import { FIGURE_MASTERS } from './life/people';

const labels = (zoom: number) => legendEntries('dark', zoom).map((e) => e.label);

it("shows the map's own standing dog in the legend", () => {
  const dog = dogPixels({ frame: 0, heading: 0 }, 10);
  const drawn = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => dog(x, y)).join(''),
  );
  expect(drawn).toEqual(DOG_ICON);
});

describe('legendEntries', () => {
  it('lists only what the map shows at the zoom', () => {
    expect(labels(7)).toContain('Terrain (by elevation)');
    expect(labels(7)).toContain('Sea');
    expect(labels(7)).not.toContain('Building');
    expect(labels(16)).toContain('Building');
    expect(labels(16)).not.toContain('Terrain (by elevation)');
    expect(labels(16)).not.toContain('Street furniture, transit stop, or shelter');
    expect(labels(18.5)).toContain('Street furniture, transit stop, or shelter');
  });

  it('counts classes that are fading in', () => {
    expect(labels(12.75)).toContain('Building');
  });

  it('merges a marker with the buildings it marks, and never lists place labels', () => {
    const school = legendEntries('dark', 16).find((e) => e.label === 'School')!;
    expect(school.classes).toEqual(expect.arrayContaining(['building_school', 'marker_school']));
    expect(school.glyphs).toContain('⌂');
    expect(labels(16)).not.toContain('Place');
  });

  it('with the classes on screen, lists only those', () => {
    const entries = legendEntries('dark', 16, ['building', 'road_major', 'marker_school']);
    const onScreen = entries.map((e) => e.label);
    expect(onScreen).toContain('Building');
    expect(onScreen).toContain('Major road');
    expect(onScreen).not.toContain('River');
    // A marker on screen brings its entry, without the buildings it marks.
    const school = entries.find((e) => e.label === 'School')!;
    expect(school.classes).toEqual(['marker_school']);
  });

  it('still hides what the zoom hides, even if reported on screen', () => {
    expect(legendEntries('dark', 7, ['building']).map((e) => e.label)).not.toContain('Building');
  });

  it('samples glyphs and colors from the theme', () => {
    const road = legendEntries('dark', 16).find((e) => e.label === 'Major road')!;
    expect(road.glyphs).toBe('═══');
    expect(road.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(legendEntries('dark', 7).find((e) => e.label.startsWith('Terrain'))!.glyphs).toBe(
      '.:-=+*#%',
    );
  });
});

describe('legendEntries life', () => {
  const life = (zoom: number, on: boolean) =>
    legendEntries('dark', zoom, undefined, { life: on }).map((e) => e.label);

  it('lists the simulated agents only while the layer is on, from their zooms', () => {
    expect(life(18, false)).not.toContain('Traffic (simulated)');
    expect(life(14, true)).toContain('Birds (simulated)');
    expect(life(14, true)).not.toContain('Traffic (simulated)');
    expect(life(16, true)).toContain('Traffic (simulated)');
    expect(life(16, true)).not.toContain('People (simulated)');
    expect(life(18, true)).toContain('People (simulated)');
  });

  it('pictures people as the map draws them: a figure and an umbrella', () => {
    for (const theme of ['dark', 'light'] as const) {
      const entries = legendEntries(theme, 18, undefined, { life: true });
      const people = entries.find((e) => e.label === 'People (simulated)')!;
      expect(people.icons).toHaveLength(2);
      const [figure, umbrella] = people.icons!;
      expect(figure!.pixels).toBe(FIGURE_MASTERS.adult[10]);
      expect(umbrella!.pixels).toBe(FIGURE_MASTERS.umbrella[10]);
      // The figure's skin is the theme's person color; the umbrella's ribs are darker than it.
      expect(figure!.tone).toBe(people.color);
      expect(umbrella!.tone).not.toBe(umbrella!.paint);
      for (const icon of people.icons!) {
        expect(new Set(icon.pixels.map((row) => row.length)).size).toBe(1);
        expect(icon.pixels.join('')).toMatch(/^[#o.]+$/);
      }
      // Glyph entries have none.
      expect(entries.find((e) => e.label === 'Traffic (simulated)')!.icons).toBeUndefined();
    }
  });

  it('lists street vendors right after people, with a cart and the vendor', () => {
    const entries = legendEntries('dark', 18, undefined, { life: true });
    const people = entries.findIndex((e) => e.label === 'People (simulated)');
    const vendors = entries[people + 1]!;
    expect(vendors.label).toBe('Street vendors (simulated)');
    expect(vendors.classes).toEqual([]);
    expect(vendors.icons).toHaveLength(2);
    expect(vendors.icons![1]!.pixels).toBe(FIGURE_MASTERS.adult[10]);
    for (const icon of vendors.icons!) {
      expect(new Set(icon.pixels.map((row) => row.length)).size).toBe(1);
      expect(icon.pixels.join('')).toMatch(/^[#o.]+$/);
    }
    // Only where people show: the layer on, from their zoom.
    expect(life(18, false)).not.toContain('Street vendors (simulated)');
    expect(life(16, true)).not.toContain('Street vendors (simulated)');
  });

  it('lists them whatever the class buffer reports, since they are never cells', () => {
    expect(legendEntries('dark', 16, ['road_major'], { life: true }).map((e) => e.label)).toContain(
      'Traffic (simulated)',
    );
  });

  it('lists streetlights while they are lit, where the roads they line are on screen', () => {
    const lit = (present: readonly string[] | undefined, lights: boolean) =>
      legendEntries('dark', 17, present as never, { lights }).map((e) => e.label);
    expect(lit(['road_mid'], true)).toContain('Streetlights');
    expect(lit(undefined, true)).toContain('Streetlights');
    expect(lit(['road_mid'], false)).not.toContain('Streetlights');
    expect(lit(['road_minor', 'building'], true)).not.toContain('Streetlights');
  });
});

it('lists static street details at strip zoom with the city sidewalk policy', () => {
  const details = (zoom: number, roads: boolean, sidewalksDerived: boolean) =>
    legendEntries('dark', zoom, roads ? ['road_mid'] : ['building'], {
      life: false,
      sidewalksDerived,
    }).map((e) => e.label);
  expect(details(18, true, false)).toEqual(
    expect.arrayContaining(['Sidewalks (mapped)', 'Stop lines', 'One-way']),
  );
  expect(details(18, true, true)).toContain('Sidewalks (partly derived)');
  for (const entries of [details(16, true, false), details(18, false, false)]) {
    expect(entries).not.toContain('Sidewalks (mapped)');
    expect(entries).not.toContain('Stop lines');
    expect(entries).not.toContain('One-way');
  }
});

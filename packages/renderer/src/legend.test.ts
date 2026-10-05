import { describe, expect, it } from 'vitest';
import { legendEntries } from './legend';
import { DOG_ICON, dogPixels } from './life/dogs';
import { FIGURE_MASTERS } from './life/people';
import { classId } from './classes';
import { normalizeFocus } from './focus';
import { themes } from './theme';

const labels = (zoom: number) => legendEntries('dark', zoom).map((e) => e.label);
it('shows an informational emoji line next to pets only while its display is eligible', () => {
  for (const theme of ['dark', 'light'] as const) {
    const entries = legendEntries(theme, 19, [], { life: true, emoji: true });
    const at = entries.findIndex((e) => e.id === 'info:emoji');
    expect(entries[at - 1]!.id).toBe('life:pets');
    expect(entries[at]).toMatchObject({ glyphs: '😊 💤', classes: [] });
    expect(entries[at]!.focus).toBeUndefined();
    for (const options of [
      { life: false, emoji: true },
      { life: true, emoji: false },
    ])
      expect(legendEntries(theme, 19, [], options).some((e) => e.id === 'info:emoji')).toBe(false);
    expect(
      legendEntries(theme, 17, [], { life: true, emoji: true }).some((e) => e.id === 'info:emoji'),
    ).toBe(false);
  }
});
it('labels atmospheric fireworks independently of Life and removes them below their zoom or in another season', () => {
  const season = {
    id: 'new-year',
    title: 'New Year',
    labels: { fireworks: 'Fireworks and smoke' },
  };
  for (const theme of ['dark', 'light'] as const) {
    const entry = legendEntries(theme, 7, [], { life: false, season }).find(
      (e) => e.id === 'info:season-fireworks',
    );
    expect(entry).toMatchObject({ classes: [], label: 'Fireworks and smoke (illustrative)' });
    for (const zoom of [7, 16, 19.99, 20, 20.999])
      expect(
        legendEntries(theme, zoom, [], { season }).some((e) => e.id === 'info:season-fireworks'),
      ).toBe(true);
    for (const zoom of [6, 21])
      expect(
        legendEntries(theme, zoom, [], { season }).some((e) => e.id === 'info:season-fireworks'),
      ).toBe(false);
    expect(
      legendEntries(theme, 19, [], { season: null }).some((e) => e.id === 'info:season-fireworks'),
    ).toBe(false);
  }
});
it('names visible installations with Life off and drops the entry after leaving the site or season', () => {
  const season = {
    id: 'winter',
    title: 'Winter',
    labels: { installations: 'Christmas trees and lights' },
  };
  const fixtures = {
    streetlights: false,
    trafficSignals: false,
    seasonal: { lanterns: false, bunting: false, installations: true },
  };
  for (const theme of ['dark', 'light'] as const)
    expect(
      legendEntries(theme, 20, ['park'], { season, fixtures, life: false }).find(
        (e) => e.id === 'info:season-installations',
      )?.label,
    ).toBe('Christmas trees and lights (illustrative)');
  expect(
    legendEntries('dark', 20, ['park'], {
      season,
      fixtures: { ...fixtures, seasonal: { ...fixtures.seasonal, installations: false } },
    }).some((e) => e.id === 'info:season-installations'),
  ).toBe(false);
  expect(
    legendEntries('dark', 20, ['park'], { fixtures }).some(
      (e) => e.id === 'info:season-installations',
    ),
  ).toBe(false);
});
it('reports seasonal hardware with Life off and temporary vendors only where paths can support them', () => {
  const season = {
    id: 'winter',
    title: 'Winter',
    labels: { lanterns: 'Parols', bunting: 'Pennants', stalls: 'Fair carts' },
  };
  const fixtures = {
    streetlights: false,
    trafficSignals: false,
    seasonal: { lanterns: true, bunting: true },
  };
  const entries = legendEntries('dark', 20, ['path'], { season, fixtures, life: false });
  expect(entries.filter((e) => e.id.startsWith('info:season-')).map((e) => e.id)).toEqual([
    'info:season-lanterns',
    'info:season-bunting',
  ]);
  expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  for (const entry of entries.filter((e) => e.id.startsWith('info:season-')))
    expect(entry.focus).toBeUndefined();
  expect(
    entries.filter((e) => e.id.startsWith('info:season-')).every((e) => e.classes.length === 0),
  ).toBe(true);
  expect(
    legendEntries('light', 20, ['path'], { season, fixtures, life: true }).find(
      (e) => e.id === 'info:season-stalls',
    )?.label,
  ).toBe('Fair carts (simulated)');
  expect(
    legendEntries('dark', 20, ['water_river'], { season, life: true }).some(
      (e) => e.id === 'info:season-stalls',
    ),
  ).toBe(false);
  expect(
    legendEntries('dark', 16, ['path'], { season, life: true }).some(
      (e) => e.id === 'info:season-stalls',
    ),
  ).toBe(false);
  expect(
    legendEntries('dark', 20, ['path'], {
      season,
      fixtures: { ...fixtures, seasonal: { lanterns: false, bunting: false } },
    }).some((e) => e.id.startsWith('info:season-')),
  ).toBe(false);
});

it('merges visible hospital roofs and markers into a distinct, focusable category in both themes', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const present of [
      ['building_hospital'],
      ['marker_hospital'],
      ['building_hospital', 'marker_hospital'],
    ] as const) {
      const entries = legendEntries(theme, 19, ['building', ...present]);
      const hospital = entries.find((e) => e.id === 'class:building_hospital')!;
      expect(hospital.label).toBe('Hospital');
      expect(hospital.classes).toEqual([...present]);
      const { mask } = normalizeFocus(hospital.focus!);
      for (const cls of present) {
        const id = classId(cls);
        expect((mask[id >>> 5]! >>> (id & 31)) & 1).toBe(1);
      }
      const generic = classId('building');
      expect((mask[generic >>> 5]! >>> (generic & 31)) & 1).toBe(0);
      expect(hospital.color).not.toBe(entries.find((e) => e.id === 'class:building')!.color);
      if (present.some((cls) => cls === 'marker_hospital')) expect(hospital.glyphs).toContain('+');
    }
    expect(themes[theme].styles.marker_hospital!.color).toBe(
      themes[theme].styles.building_hospital!.color,
    );
    expect(legendEntries(theme, 19, ['building']).some((e) => e.label === 'Hospital')).toBe(false);
    expect(legendEntries(theme, 12, ['marker_hospital']).some((e) => e.label === 'Hospital')).toBe(
      false,
    );
  }
});

it('keeps category identity through themes, class membership and changing explanatory wording', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const classes of [
      ['marker_school'],
      ['building_school'],
      ['building_school', 'marker_school'],
    ] as const) {
      const school = legendEntries(theme, 19, classes).find(
        (e) => e.id === 'class:building_school',
      );
      expect(school?.label).toBe('School');
      expect(school?.classes).toEqual([...classes]);
    }
    for (const sidewalksDerived of [true, false]) {
      const entries = legendEntries(theme, 20, undefined, {
        life: true,
        sidewalksDerived,
        fixtures: {
          streetlights: true,
          trafficSignals: true,
          utilities: true,
        },
      });
      expect(entries.find((e) => e.id === 'info:sidewalks')?.label).toBe(
        sidewalksDerived ? 'Sidewalks (partly derived)' : 'Sidewalks (mapped)',
      );
      expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
      expect(entries.find((e) => e.id === 'class:tree')?.classes).toEqual(
        expect.arrayContaining(['tree', 'tree_crown']),
      );
      expect(entries.find((e) => e.id === 'class:building_market')?.label).toBe('Market or shop');
      expect(entries.find((e) => e.id === 'class:marker_market')?.label).toBe('Market');
    }
  }
});

it('describes utilities with Life off, only when reported, and switches glyphs at 19.5', () => {
  const entry = (zoom: number, utilities?: boolean) =>
    legendEntries('light', zoom, [], {
      life: false,
      lights: false,
      fixtures: { streetlights: false, trafficSignals: false, utilities },
    }).find((e) => e.label === 'Utility poles and wires (illustrative)');
  expect(entry(18.5, true)?.glyphs).toBe('●─');
  expect(entry(19.5, true)?.glyphs).toBe('●╳∞');
  expect(entry(20, false)).toBeUndefined();
  expect(entry(20)).toBeUndefined();
});

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

it('lists visible hardware during daytime with Life off and honors explicit absence', () => {
  const fixtures = { streetlights: true, trafficSignals: true };
  const entries = legendEntries('dark', 20, ['road_mid'], { life: false, lights: false, fixtures });
  expect(entries.map((e) => e.label)).toEqual(
    expect.arrayContaining(['Streetlights', 'Traffic signals (simulated phases)']),
  );
  expect(entries.find((e) => e.label === 'Streetlights')!.glyphs).toBe('▪─▫');
  const absent = legendEntries('dark', 20, ['road_mid'], {
    life: true,
    lights: true,
    fixtures: { streetlights: false, trafficSignals: false },
  });
  expect(absent.map((e) => e.label)).not.toContain('Streetlights');
  expect(absent.map((e) => e.label)).not.toContain('Traffic signals (simulated phases)');
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
it('describes memorial candles with Life off and gates informational seasonal crowds by person zoom', () => {
  const season = {
    id: 'memorial',
    title: 'Memorial',
    labels: { candles: 'Candles', visitors: 'Families', congregations: 'Mass-goers' },
  };
  const fixtures = {
    streetlights: false,
    trafficSignals: false,
    seasonal: { lanterns: false, bunting: false, candles: true },
  };
  const candles = legendEntries('dark', 19, [], { season, fixtures, life: false }).filter((e) =>
    e.id.startsWith('info:season-'),
  );
  expect(candles.map((e) => e.id)).toEqual(['info:season-candles']);
  expect(candles[0]!.icons).toHaveLength(1);
  expect(candles[0]!.glyphs).toBe('');
  const people = legendEntries('light', 19, [], { season, life: true }).filter((e) =>
    e.id.startsWith('info:season-'),
  );
  expect(people.map((e) => e.label)).toEqual(['Families (simulated)', 'Mass-goers (simulated)']);
  expect(people.every((e) => e.icons?.length && !e.focus)).toBe(true);
  expect(
    legendEntries('dark', 16, [], { season, life: true }).some((e) =>
      e.id.startsWith('info:season-'),
    ),
  ).toBe(false);
  expect(
    legendEntries('dark', 19, [], { life: true }).some((e) => e.id.startsWith('info:season-')),
  ).toBe(false);
});

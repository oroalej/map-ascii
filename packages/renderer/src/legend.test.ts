import { describe, expect, it } from 'vitest';
import { legendEntries } from './legend';

const labels = (zoom: number) => legendEntries('dark', zoom).map((e) => e.label);

describe('legendEntries', () => {
  it('lists only what the map shows at the zoom', () => {
    expect(labels(7)).toContain('Terrain (by elevation)');
    expect(labels(7)).toContain('Sea');
    expect(labels(7)).not.toContain('Building');
    expect(labels(16)).toContain('Building');
    expect(labels(16)).not.toContain('Terrain (by elevation)');
    expect(labels(16)).not.toContain('Bench, fountain, or flagpole');
    expect(labels(18.5)).toContain('Bench, fountain, or flagpole');
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

  it('lists them whatever the class buffer reports, since they are never cells', () => {
    expect(legendEntries('dark', 16, ['road_major'], { life: true }).map((e) => e.label)).toContain(
      'Traffic (simulated)',
    );
  });
});

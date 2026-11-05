import { describe, expect, it } from 'vitest';
import { curveAt, placeShare, rhythmFor, districtFactor, type CityLifeConfig } from '@atlas/shared';
import { City } from '@atlas/shared/schemas';

const cityFiles = import.meta.glob('../cities/naga/city.json', { eager: true, import: 'default' });
const life = City.parse(Object.values(cityFiles)[0]).life as CityLifeConfig;
const MONDAY = 1;
const SATURDAY = 6;
const SUNDAY = 0;
const out = (kind: 'vehicle' | 'person', hour: number, weekday: number) =>
  curveAt(rhythmFor(life, kind, weekday), hour * 60);
const people = (district: 'centre' | 'home', hour: number, weekday: number) =>
  out('person', hour, weekday) * districtFactor(life, district, { minutes: hour * 60, weekday });

describe("Naga's daily rhythm", () => {
  it('fills Centro by day and empties it at night', () => {
    expect(people('centre', 10, MONDAY)).toBeGreaterThan(2 * people('centre', 22, MONDAY));
    expect(people('centre', 3, MONDAY)).toBeLessThan(0.05);
  });

  it('keeps residential streets quiet at midday and full at dusk', () => {
    expect(people('home', 18, MONDAY)).toBeGreaterThan(1.5 * people('home', 12, MONDAY));
    expect(people('home', 18, MONDAY)).toBeGreaterThan(people('centre', 22, MONDAY));
  });

  it('has Centro busier than home streets at midday, and home streets busier at 22:00', () => {
    expect(people('centre', 12, MONDAY)).toBeGreaterThan(people('home', 12, MONDAY));
    expect(people('home', 22, MONDAY)).toBeGreaterThan(people('centre', 22, MONDAY));
  });

  it('starts weekends later than school days', () => {
    expect(out('vehicle', 7.5, SUNDAY)).toBeLessThan(0.6 * out('vehicle', 7.5, MONDAY));
    expect(out('vehicle', 7.5, SATURDAY)).toBeLessThan(out('vehicle', 7.5, MONDAY));
    expect(people('centre', 12, SATURDAY)).toBeGreaterThan(people('centre', 7, SATURDAY));
  });

  it('crowds churches for Sunday Mass, and no school gates at the weekend', () => {
    const clock = (hour: number, weekday: number) => ({ minutes: hour * 60, weekday });
    expect(placeShare('worship', clock(9, SUNDAY), life)).toBe(1);
    expect(placeShare('worship', clock(14, MONDAY), life)).toBeLessThan(0.2);
    expect(placeShare('school', clock(7.25, MONDAY), life)).toBe(1);
    expect(placeShare('school', clock(7.25, SUNDAY), life)).toBeLessThan(0.05);
  });
});

import { describe, expect, it } from 'vitest';
import { Procession } from './schemas';
import {
  eventOccurrence,
  eventTime,
  processionReferenceErrors,
  resolveProcessionSchedules,
} from './processions';

const moving = Procession.parse({
  id: 'procession/start',
  title: { en: 'Start' },
  story: { en: 'Illustrative' },
  status: 'draft',
  kind: 'procession',
  route: { from: 'osm:way/1', to: 'osm:way/2' },
  schedule: {
    month: 9,
    nth: 3,
    weekday: 6,
    offset_days: -8,
    start: '23:30',
    duration_min: 90,
    timezone: 'Asia/Manila',
  },
});
const mass = Procession.parse({
  id: 'procession/mass',
  title: { en: 'Mass' },
  story: { en: 'Illustrative' },
  status: 'draft',
  kind: 'mass',
  site: 'osm:way/2',
  grounds: ['osm:way/3'],
  radius_m: 100,
  schedule: { follows: moving.id, duration_min: 60 },
});
describe('event occurrence and dependency resolution', () => {
  it('resolves out of order and carries midnight without changing the annual rule', () => {
    const resolved = resolveProcessionSchedules([mass, moving]).get(mass.id)!;
    expect(resolved).toMatchObject({ offset_days: -7, start: '01:00', duration_min: 60 });
    const timing = eventOccurrence(resolved, new Date('2026-01-01T00:00:00Z'));
    expect(new Date(timing.startMs).toISOString()).toBe('2026-09-11T17:00:00.000Z');
  });
  it('reports missing, self and cyclic references and unknown seasons', () => {
    const self = { ...mass, schedule: { follows: mass.id, duration_min: 60 }, season: 'missing' };
    expect(processionReferenceErrors([self], []).map((e) => e.message)).toEqual([
      expect.stringContaining('unknown season'),
      expect.stringContaining('cyclic'),
    ]);
    expect(() => resolveProcessionSchedules([mass])).toThrow('Missing');
    expect(() => resolveProcessionSchedules([self])).toThrow('Cyclic');
    const start = { ...moving, schedule: { follows: mass.id, duration_min: 90 } };
    expect(processionReferenceErrors([start, mass], [])).toHaveLength(2);
  });
  it('maps authoritative progress through local midnight, including a different IANA offset', () => {
    const timing = eventOccurrence(
      'follows' in moving.schedule
        ? (() => {
            throw Error();
          })()
        : moving.schedule,
      new Date('2026-01-01'),
    );
    expect(eventTime(timing, 0)).toMatchObject({ date: '2026-09-11', time: '23:30' });
    expect(eventTime(timing, 1)).toMatchObject({ date: '2026-09-12', time: '01:00' });
    const schedule = {
      month: 9,
      nth: 3,
      weekday: 6,
      offset_days: 0,
      start: '07:00',
      duration_min: 120,
      timezone: 'America/New_York',
    };
    expect(new Date(eventOccurrence(schedule, new Date('2026-06-01')).startMs).toISOString()).toBe(
      '2026-09-19T11:00:00.000Z',
    );
  });
});

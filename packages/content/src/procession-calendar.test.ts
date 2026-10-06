import { expect, it } from 'vitest';
import {
  activeSeason,
  eventOccurrence,
  eventTime,
  resolveProcessionSchedules,
} from '@atlas/shared';
import { contentRoot, loadCityPacks } from './validate';
import.meta.glob('../cities/**/processions/*.json');
import.meta.glob('../cities/**/city.json');
it('keeps all five fiesta events in actual calendar order across early and late third Saturdays', async () => {
  const pack = (await loadCityPacks(contentRoot, { only: 'naga' })).packs[0]!;
  const schedules = resolveProcessionSchedules(pack.content.processions);
  for (const [year, dates] of [
    [2024, [13, 20, 21]],
    [2026, [11, 18, 19]],
    [2029, [7, 14, 15]],
    [2030, [13, 20, 21]],
  ] as const) {
    const now = new Date(`${year}-06-01T00:00:00Z`);
    const times = pack.content.processions
      .map((p) => ({ p, time: eventTime(eventOccurrence(schedules.get(p.id)!, now), 0) }))
      .sort((a, b) => a.time.instantMs - b.time.instantMs);
    expect(times.map((x) => x.p.label?.en)).toEqual([
      'Procession',
      'Mass at the Cathedral',
      'Military parade',
      'Fluvial',
      'Mass at the Basilica',
    ]);
    expect(times.map((x) => x.time.date)).toEqual(
      [dates[0], dates[0], dates[1], dates[2], dates[2]].map(
        (day) => `${year}-09-${String(day).padStart(2, '0')}`,
      ),
    );
    expect(times.map((x) => x.time.time)).toEqual(['12:00', '16:00', '07:00', '15:00', '18:30']);
    for (const { p, time } of times)
      expect(activeSeason(pack.city.life?.seasons, year, time.day)?.id).toBe(p.season);
  }
});

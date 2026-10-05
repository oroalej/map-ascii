/** Event dependency and occurrence arithmetic; safe to import without Zod in the browser. */
import { nthWeekdayDay } from './seasons';
import type { Procession, ProcessionSchedule } from './schemas';

export function processionReferenceErrors(
  records: readonly Procession[],
  seasons: readonly { id: string }[],
): { id: string; message: string }[] {
  const byId = new Map(records.map((p) => [p.id, p]));
  const errors: { id: string; message: string }[] = [];
  for (const p of records) {
    if (p.season && !seasons.some((s) => s.id === p.season))
      errors.push({ id: p.id, message: `unknown season "${p.season}"` });
    const seen = new Set([p.id]);
    let next: Procession | undefined = p;
    while (next && 'follows' in next.schedule) {
      const id: string = next.schedule.follows;
      if (seen.has(id)) {
        errors.push({ id: p.id, message: `cyclic follows reference "${id}"` });
        break;
      }
      seen.add(id);
      next = byId.get(id);
      if (!next) errors.push({ id: p.id, message: `missing predecessor "${id}"` });
    }
  }
  return errors;
}

export function resolveProcessionSchedules(
  records: readonly Procession[],
): Map<string, ProcessionSchedule> {
  const byId = new Map(records.map((p) => [p.id, p]));
  const result = new Map<string, ProcessionSchedule>();
  const visiting = new Set<string>();
  const resolve = (id: string): ProcessionSchedule => {
    const saved = result.get(id);
    if (saved) return saved;
    const p = byId.get(id);
    if (!p) throw new Error(`Missing procession predecessor ${id}`);
    if (visiting.has(id)) throw new Error(`Cyclic procession schedule ${id}`);
    visiting.add(id);
    let schedule: ProcessionSchedule;
    if ('follows' in p.schedule) {
      const parent = resolve(p.schedule.follows);
      const [h, m] = parent.start.split(':').map(Number);
      const end = h! * 60 + m! + parent.duration_min;
      const offset_days = parent.offset_days + Math.floor(end / 1440);
      if (offset_days < -31 || offset_days > 31) throw new Error(`Unrepresentable schedule ${id}`);
      const minute = end % 1440;
      schedule = {
        ...parent,
        offset_days,
        start: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
        duration_min: p.schedule.duration_min,
      };
    } else schedule = p.schedule;
    visiting.delete(id);
    result.set(id, schedule);
    return schedule;
  };
  for (const p of records) resolve(p.id);
  return result;
}

export type EventTiming = { startMs: number; duration_min: number; timezone: string };
export type EventTime = {
  instantMs: number;
  day: number;
  minute: number;
  date: string;
  time: string;
};
export function eventLocalParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: n('year'),
    month: n('month'),
    date: n('day'),
    hour: n('hour'),
    minute: n('minute'),
  };
}

/** Resolve in the actual local year, including zone offsets at the occurrence, not today. */
export function eventOccurrence(schedule: ProcessionSchedule, now: Date): EventTiming {
  const year = eventLocalParts(now, schedule.timezone).year;
  const [h, m] = schedule.start.split(':').map(Number);
  const localMs = nthWeekdayDay(schedule, year) * 86400000 + (h! * 60 + m!) * 60000;
  let startMs = localMs;
  for (let i = 0; i < 3; i++) {
    const p = eventLocalParts(new Date(startMs), schedule.timezone);
    const projected = Date.UTC(p.year, p.month - 1, p.date, p.hour, p.minute);
    startMs += localMs - projected;
  }
  return { startMs, duration_min: schedule.duration_min, timezone: schedule.timezone };
}

export function eventTime(timing: EventTiming, progress: number): EventTime {
  const instantMs =
    timing.startMs + Math.max(0, Math.min(1, progress)) * timing.duration_min * 60000;
  const p = eventLocalParts(new Date(instantMs), timing.timezone);
  const pad = (v: number) => String(v).padStart(2, '0');
  return {
    instantMs,
    day: Math.floor(Date.UTC(p.year, p.month - 1, p.date) / 86400000),
    minute: p.hour * 60 + p.minute,
    date: `${p.year}-${pad(p.month)}-${pad(p.date)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

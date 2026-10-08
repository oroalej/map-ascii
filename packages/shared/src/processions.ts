/** Event dependency and occurrence arithmetic; safe to import without Zod in the browser. */
import { nthWeekdayDay, epochDay } from './seasons';
import { localDateParts } from './clock';
import { PROCESSION_LIMITS } from './constants';
import type { Procession, ProcessionRoute, ProcessionSchedule } from './schemas';

export class ProcessionScheduleError extends Error {
  constructor(
    readonly id: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessionScheduleError';
  }
}

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
      const [minimum, maximum] = PROCESSION_LIMITS.schedule.offset_days;
      if (offset_days < minimum || offset_days > maximum)
        throw new ProcessionScheduleError(
          id,
          `Unrepresentable schedule ${id}: resolved offset ${offset_days} is outside ${minimum}…${maximum}`,
        );
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

/** Resolve in the actual local year, including zone offsets at the occurrence, not today. */
export function eventOccurrence(schedule: ProcessionSchedule, now: Date): EventTiming {
  const year = localDateParts(now, schedule.timezone).year;
  const [h, m] = schedule.start.split(':').map(Number);
  const localMs = nthWeekdayDay(schedule, year) * 86400000 + (h! * 60 + m!) * 60000;
  let startMs = localMs;
  for (let i = 0; i < 3; i++) {
    const p = localDateParts(new Date(startMs), schedule.timezone);
    const projected = Date.UTC(p.year, p.month - 1, p.date, p.hour, p.minute);
    startMs += localMs - projected;
  }
  return { startMs, duration_min: schedule.duration_min, timezone: schedule.timezone };
}

export function eventTime(timing: EventTiming, progress: number): EventTime {
  const instantMs =
    timing.startMs + Math.max(0, Math.min(1, progress)) * timing.duration_min * 60000;
  const p = localDateParts(new Date(instantMs), timing.timezone);
  const pad = (v: number) => String(v).padStart(2, '0');
  return {
    instantMs,
    day: epochDay(p.year, p.month, p.date),
    minute: p.hour * 60 + p.minute,
    date: `${p.year}-${pad(p.month)}-${pad(p.date)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/**
 * Where an event begins on the map: a Mass's gathering anchor, a river procession's departure
 * (where the pagoda sets off, past the river kept behind it), else the route's first point.
 */
export function eventStart(route: ProcessionRoute): [number, number] {
  if (route.kind === 'mass') return route.site.anchor;
  const points = route.route;
  let left = route.kind === 'fluvial' ? (route.departure_m ?? 0) : 0;
  for (let i = 1; i < points.length && left > 0; i++) {
    const [a, b] = [points[i - 1]!, points[i]!];
    const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
    const step = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110_540);
    if (step >= left) {
      const t = left / step;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= step;
  }
  return left > 0 ? points.at(-1)! : points[0]!;
}

import type { ProcessionRoute } from '@atlas/shared';

const schedule = {
  month: 9,
  weekday: 6,
  nth: 3,
  offset_days: -8,
  start: '12:00',
  duration_min: 240,
  timezone: 'Asia/Manila',
};
const common = { title: { en: 'Illustrative event' }, status: 'draft' as const, season: 'feast' };
const route: [[number, number], [number, number]] = [
  [1, 2],
  [1.001, 2],
];
const street = {
  ...common,
  id: 'street',
  kind: 'procession' as const,
  label: { en: 'Procession' },
  schedule,
  route,
  length_m: 100,
  segments: [{ id: 'osm:way/1' as const, width_m: 8, sidewalk_m: 2 }],
  blocked: [],
};
const site = {
  id: 'osm:way/2' as const,
  location: [1, 2] as [number, number],
  anchor: [1.0001, 2.0001] as [number, number],
  radius_m: 100,
  grounds: [],
  blocked: [],
  approaches: [],
  roads: [],
};
export const eventFixtures: ProcessionRoute[] = [
  street,
  {
    ...common,
    id: 'cathedral',
    kind: 'mass',
    label: { en: 'Mass at the Cathedral' },
    follows: street.id,
    schedule: { ...schedule, start: '16:00', duration_min: 90 },
    site,
  },
  {
    ...common,
    id: 'parade',
    kind: 'parade',
    label: { en: 'Military parade' },
    schedule: { ...schedule, offset_days: -1, start: '07:00', duration_min: 120 },
    route,
    length_m: 100,
    segments: street.segments,
    blocked: [],
  },
  {
    ...common,
    id: 'fluvial',
    kind: 'fluvial',
    label: { en: 'Fluvial' },
    schedule: { ...schedule, offset_days: 0, start: '15:00', duration_min: 210 },
    route,
    length_m: 100,
  },
  {
    ...common,
    id: 'basilica',
    kind: 'mass',
    label: { en: 'Mass at the Basilica' },
    follows: 'fluvial',
    schedule: { ...schedule, offset_days: 0, start: '18:30', duration_min: 90 },
    site,
  },
];

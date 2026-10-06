import type { StreetRoute } from '@atlas/shared';

/** Event geography deliberately remote from the ordinary scenario tiles. */
export const remoteGroundEvent: StreetRoute = {
  id: 'procession/remote',
  kind: 'procession',
  title: { en: 'Remote event' },
  status: 'draft',
  route: [
    [20, 10],
    [20.001, 10],
  ],
  length_m: 100,
  segments: [{ id: 'osm:way/1', width_m: 8, sidewalk_m: 1 }],
  blocked: [],
  schedule: {
    month: 9,
    weekday: 6,
    nth: 3,
    offset_days: 0,
    start: '12:00',
    duration_min: 240,
    timezone: 'Asia/Manila',
  },
};

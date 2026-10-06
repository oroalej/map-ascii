import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CityProcessions,
  localMetricProjection,
  LEGACY_LOCAL_METERS_PER_DEGREE,
  PROCESSION_GEOMETRY,
} from '@atlas/shared';
import churches from './testing/arrival-churches.json';
import lock from '../../../content/cities/naga/tiles.lock.json';
import { GroundProcessionScene } from './procession-street';
import { bodyHitsPolygon, segmentBody } from './occupancy';
import { eventBodySize } from './event-actors';

// Select this integration test when generated geography or authored exterior anchors change.
import.meta.glob('../../../../apps/web/public/tiles/*.processions.json');
import.meta.glob('../../../content/cities/naga/processions/*.json');
const archive = new URL('../../../../apps/web/public/tiles/naga.pmtiles', import.meta.url);
const routes = CityProcessions.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../apps/web/public/tiles/naga.processions.json', import.meta.url),
      'utf8',
    ),
  ),
).processions;
describe('shipped exterior Mass gatherings', () => {
  it('binds church outlines to pinned geometry while allowing event-only releases', () => {
    expect(churches.geometrySha256).toBe(lock.files['naga.pmtiles']);
  });
  // Unit-only CI checkouts contain the tracked event JSON but no downloaded archive.
  // Any checkout using actual tiles also verifies unpublished geometry changes.
  it.runIf(existsSync(archive))(
    'matches the actual geometry archive used with generated events',
    () => {
      expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(
        churches.geometrySha256,
      );
    },
  );
  for (const route of routes) {
    if (route.kind !== 'mass') continue;
    it(`keeps all ${route.id} approaches, exits and complete crowd footprints outside the church`, () => {
      const frame = localMetricProjection(route.site.location, {
        east: LEGACY_LOCAL_METERS_PER_DEGREE,
        north: LEGACY_LOCAL_METERS_PER_DEGREE,
      });
      const position = (q: readonly number[]) => {
        const p = frame.to([q[0]!, q[1]!]);
        return { x: p[0], y: p[1] };
      };
      const roof = (churches.buildings as Record<string, number[][][]>)[route.site.id]!.map(
        (ring) => ring.map(position),
      );
      const scene = new GroundProcessionScene(route);
      expect(scene.agents(0.5, 0).length).toBeGreaterThan(50);
      for (const path of route.site.approaches)
        for (let i = 1; i < path.length; i++)
          expect(
            bodyHitsPolygon(
              segmentBody(
                position(path[i - 1]!),
                position(path[i]!),
                Math.hypot(
                  PROCESSION_GEOMETRY.person.length / 2 + PROCESSION_GEOMETRY.probePadding,
                  PROCESSION_GEOMETRY.person.width / 2 + PROCESSION_GEOMETRY.probePadding,
                ),
              ),
              roof,
            ),
          ).toBe(false);
      for (const progress of [0, 0.03, 0.08, 0.15, 0.22, 0.25, 0.5, 0.75, 0.8, 0.9, 0.98])
        for (const agent of scene.agents(progress, 0)) {
          const at = position([agent.lng, agent.lat]),
            ahead = position(agent.ahead!);
          const dx = ahead.x - at.x,
            dy = ahead.y - at.y,
            norm = Math.hypot(dx, dy);
          const size = eventBodySize(agent);
          expect(
            bodyHitsPolygon(
              {
                ...at,
                hx: dx / norm,
                hy: dy / norm,
                length: size.length + 2 * PROCESSION_GEOMETRY.probePadding,
                width: size.width + 2 * PROCESSION_GEOMETRY.probePadding,
              },
              roof,
            ),
          ).toBe(false);
        }
    });
  }
  it('covers both authored church arrivals', () =>
    expect(routes.filter((route) => route.kind === 'mass')).toHaveLength(2));
});

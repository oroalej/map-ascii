import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  localMetricProjection,
  LEGACY_LOCAL_METERS_PER_DEGREE,
  PROCESSION_GEOMETRY,
} from '@atlas/shared';
import { CityProcessions } from '@atlas/shared/schemas';
import churches from './testing/arrival-churches.json';
import lock from '../../../content/cities/naga/tiles.lock.json';
import { GroundProcessionScene } from './procession-street';
import { bodyHitsPolygon, segmentBody } from './occupancy';
import { eventBodySize } from './event-actors';
import { packLife } from './draw';
import { groundForRoute, eventGroundAllows } from './ground-events';
import { themes, mapGlyphs } from '../theme';
import { ProcessionGlyph } from './procession-glyphs';

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
    if (route.site.altar)
      it(`keeps the celebrants and both images packed throughout ${route.id}`, () => {
        const frame = localMetricProjection(route.site.altar!.at),
          ground = groundForRoute(route),
          glyphs = mapGlyphs(themes.dark);
        const toCell = (lng: number, lat: number): [number, number] => {
          const [x, y] = frame.to([lng, lat]);
          return [x / 0.25 + 60, -y / 0.25 + 60];
        };
        const fromCell = (c: number, r: number) => frame.from([(c - 60) * 0.25, -(r - 60) * 0.25]);
        for (const progress of [0.05, 0.5, 0.95]) {
          const actors = new GroundProcessionScene(route)
            .agents(progress, 0)
            .filter((a) => a.eventRole === 'altar');
          expect(actors).toHaveLength(15);
          const out = new Uint8Array(120 * 120 * 4),
            owners = new Uint32Array(120 * 120);
          packLife(
            out,
            {
              cols: 120,
              rows: 120,
              cellWidth: 10,
              cellHeight: 18,
              toCell,
              allowsGroundCell: (a, c, r) =>
                eventGroundAllows(a.eventRole === 'altar' ? ground.altar! : ground, [
                  fromCell(c + 0.5, r + 0.5),
                  fromCell(c, r),
                  fromCell(c + 1, r),
                  fromCell(c + 1, r + 1),
                  fromCell(c, r + 1),
                ]),
            },
            actors,
            themes.dark,
            (g) => Math.max(0, glyphs.indexOf(g)),
            undefined,
            undefined,
            { owners },
          );
          const people = actors
            .map((a, i) => ({ a, owner: i + 1 }))
            .filter(({ a }) => !a.glyph || a.glyph === ProcessionGlyph.andas);
          expect(people).toHaveLength(10);
          for (const { owner } of people)
            expect(owners.some((value) => value === owner)).toBe(true);
          expect(new Set(actors.filter((a) => !a.glyph).map((a) => a.paint))).toEqual(
            new Set([0, 7]),
          );
        }
      });
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

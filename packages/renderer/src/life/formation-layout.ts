/** One physical layout for simulated members, unsimulated blocks, and head/entry timing. */
import {
  PROCESSION_DEFAULTS,
  PROCESSION_GEOMETRY,
  processionFormationWidth,
  type StreetRoute,
} from '@atlas/shared';
import { ProcessionGlyph } from './procession-glyphs';
import { PROCESSION, motionProfile, profileAt } from './procession';
import { hashString } from './random';
type Member = {
  back: number;
  off: number;
  paint: number;
  glyph?: string;
  vehicle?: 'car' | 'truck' | 'motorcycle';
};
export type FormationBlock = {
  back: number;
  length: number;
  count: number;
  columns: number;
  paint: number;
  index: number;
};
const cached = new WeakMap<StreetRoute, ReturnType<typeof build>>();
function build(route: StreetRoute) {
  const g = PROCESSION_GEOMETRY;
  const minimum = processionFormationWidth(
    route.kind,
    route.kind === 'parade' ? route.formation?.vehicles : [],
  );
  // The entire column reflows before a transition. This conservative width includes bends
  // and every segment touched by a member, without changing identities during the run.
  const clear = Math.min(...route.segments.map((s) => Math.min(s.width_m, s.clear_m ?? minimum)));
  const maxColumns = route.formation?.columns ?? PROCESSION_DEFAULTS[route.kind].columns;
  const columns = Math.max(
    1,
    Math.min(
      maxColumns,
      Math.floor(
        (clear - 2 * (g.probePadding + g.clearanceMargin) - g.person.width) / g.columnPitch + 1e-9,
      ) + 1,
    ),
  );
  const actors: Member[] = [],
    blocks: FormationBlock[] = [];
  const row = (count: number, back: number, paint: number, glyph?: string) => {
    for (let i = 0; i < count; i++)
      actors.push({
        back: back + Math.floor(i / columns) * 2,
        off:
          ((i % columns) - (Math.min(columns, count - Math.floor(i / columns) * columns) - 1) / 2) *
          g.columnPitch,
        paint,
        glyph,
      });
    return Math.ceil(count / columns) * 2;
  };
  let tail = 0,
    leading = 0;
  if (route.kind === 'procession') {
    const f = { ...PROCESSION_DEFAULTS.procession, ...route.formation };
    for (let image = 0; image < f.images; image++) {
      const centre = image * 35;
      actors.push({ back: centre, off: 0, paint: 4, glyph: ProcessionGlyph.andas });
      const front = Math.ceil(f.bearers / 2),
        rear = f.bearers - front;
      // Bearers stand fore and aft, leaving the full andas footprint clear on narrow roads.
      row(front, centre - 4 - Math.ceil(front / columns) * 2, 3);
      row(rear, centre + 4, 3);
    }
    row(f.marshals, -55, 6, ProcessionGlyph.flag);
    row(f.ranks * f.columns, (f.images - 1) * 35 + 30, 3);
    leading = 60;
    tail = Math.max(
      route.crowd_grounds !== undefined || route.segments.some((s) => s.verge_m) ? 500 : 0,
      ...actors.map((a) => a.back + 10),
    );
  } else {
    const f = { ...PROCESSION_DEFAULTS.parade, vehicles: [], ...route.formation };
    let back = row(f.color_guard, 0, 5, ProcessionGlyph.flag) + PROCESSION.street.guardGap;
    for (let k = 0; k < f.contingents; k++) {
      if (
        f.bands &&
        k % Math.max(1, Math.ceil(f.contingents / f.bands)) === 0 &&
        blocks.length / Math.max(1, Math.ceil(f.contingents / f.bands)) < f.bands
      ) {
        for (let i = 0; i < f.band; i++)
          actors.push({
            back: back + Math.floor(i / columns) * 2,
            off: ((i % columns) - (columns - 1) / 2) * g.columnPitch,
            paint: 4,
            glyph: i % 2 ? ProcessionGlyph.bugle : ProcessionGlyph.drum,
          });
        back += Math.ceil(f.band / columns) * 2 + PROCESSION.street.bandGap;
      }
      const count = f.ranks * f.columns,
        length = Math.ceil(count / columns) * 2;
      blocks.push({
        back,
        length,
        count,
        columns,
        paint: PROCESSION.throng.uniforms[k % PROCESSION.throng.uniforms.length]!,
        index: k,
      });
      back += length + PROCESSION.street.contingentGap;
    }
    for (const vehicle of f.vehicles) {
      actors.push({ back, off: 0, paint: 5, vehicle });
      back += 14;
    }
    tail = back + 10;
    leading = 3;
  }
  const profile = motionProfile(hashString(route.id), route.length_m);
  return {
    actors,
    blocks,
    columns,
    clear,
    tail,
    leading,
    head: (progress: number) =>
      (route.kind === 'parade' ? progress : profileAt(profile, progress)) *
        (route.length_m + tail + leading) -
      leading,
  };
}
export function formationLayout(route: StreetRoute) {
  let layout = cached.get(route);
  if (!layout) cached.set(route, (layout = build(route)));
  return layout;
}

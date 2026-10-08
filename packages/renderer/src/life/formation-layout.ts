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
  const row = (
    count: number,
    back: number,
    paint: number,
    glyph?: string | ((index: number) => string),
  ) => {
    for (let i = 0; i < count; i++)
      actors.push({
        back: back + Math.floor(i / columns) * g.rowPitch,
        off:
          ((i % columns) - (Math.min(columns, count - Math.floor(i / columns) * columns) - 1) / 2) *
          g.columnPitch,
        paint,
        glyph: typeof glyph === 'function' ? glyph(i) : glyph,
      });
    return Math.ceil(count / columns) * g.rowPitch;
  };
  let tail = 0,
    leading = 0;
  if (route.kind === 'procession') {
    const f = { ...PROCESSION_DEFAULTS.procession, ...route.formation };
    const front = Math.ceil(f.bearers / 2),
      rear = f.bearers - front;
    const frontBack = -PROCESSION.street.andasGap - (Math.ceil(front / columns) - 1) * g.rowPitch;
    const rearBack = PROCESSION.street.andasGap;
    const groupFront = Math.min(-g.andas.length / 2, frontBack - g.person.length / 2);
    const groupBack = Math.max(
      g.andas.length / 2,
      rearBack + (Math.ceil(rear / columns) - 1) * g.rowPitch + g.person.length / 2,
    );
    let centre = 0,
      lastBack = 0;
    for (let image = 0; image < f.images; image++) {
      actors.push({ back: centre, off: 0, paint: 4, glyph: ProcessionGlyph.andas });
      row(front, centre + frontBack, 3);
      row(rear, centre + rearBack, 3);
      lastBack = centre + groupBack;
      centre += groupBack - groupFront + PROCESSION.street.imageGap;
    }
    row(
      f.marshals,
      groupFront -
        PROCESSION.street.marshalGap -
        g.person.length / 2 -
        (Math.ceil(f.marshals / columns) - 1) * g.rowPitch,
      6,
      ProcessionGlyph.flag,
    );
    row(f.ranks * f.columns, lastBack + PROCESSION.street.devoteeGap + g.person.length / 2, 3);
    leading = Math.max(
      PROCESSION.street.leading,
      ...actors.map(
        (a) =>
          -a.back +
          (a.glyph === ProcessionGlyph.andas ? g.andas.length : g.person.length) / 2 +
          g.probePadding,
      ),
    );
    tail = Math.max(
      route.crowd_grounds !== undefined || route.segments.some((s) => s.verge_m)
        ? PROCESSION.street.crowdTail
        : 0,
      ...actors.map((a) => a.back + PROCESSION.street.tailPadding),
    );
  } else {
    const f = { ...PROCESSION_DEFAULTS.parade, vehicles: [], ...route.formation };
    let back = row(f.color_guard, 0, 5, ProcessionGlyph.flag) + PROCESSION.street.guardGap;
    for (let k = 0; k < f.contingents; k++) {
      if (f.bands && k % Math.max(1, Math.ceil(f.contingents / f.bands)) === 0)
        back +=
          row(f.band, back, 4, (i) => (i % 2 ? ProcessionGlyph.bugle : ProcessionGlyph.drum)) +
          PROCESSION.street.bandGap;
      const count = f.ranks * f.columns,
        length = Math.ceil(count / columns) * g.rowPitch;
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
      const length = g.vehicles[vehicle].length;
      actors.push({ back: back + length / 2, off: 0, paint: 5, vehicle });
      back += length + PROCESSION.street.vehicleGap;
    }
    tail = back + PROCESSION.street.tailPadding;
    leading = PROCESSION.street.leading;
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

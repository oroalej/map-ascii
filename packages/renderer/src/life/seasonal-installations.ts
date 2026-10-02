import type { SeasonConfig, SeasonalDisplayRecord, SeasonalLightStringRecord } from '@atlas/shared';
import type { FixtureGrid } from './fixtures';
import { SeasonalPart, SEASONAL_GLYPHS } from './seasonal-glyphs';
import { LampState, type VisibleLamp } from './lights';

export type InstallationRecord = SeasonalDisplayRecord | SeasonalLightStringRecord;
export type InstallationFixture = { kind: 'season-installation'; record: InstallationRecord };
export function admitsInstallation(record: InstallationRecord, season: SeasonConfig) {
  return (
    record.season === season.id &&
    season.installations?.some(
      (i) =>
        i.id === record.installation &&
        i.anchor === record.anchor &&
        i.kind === record.kind &&
        (i.kind !== 'light-string' ||
          record.kind !== 'light-string' ||
          (i.layout === 'building-perimeter' ? 'building' : i.mount) === record.mount),
    ) === true
  );
}
const metric = (at: [number, number], east: number, north: number): [number, number] => [
  at[0] + east / (111320 * Math.cos((at[1] * Math.PI) / 180)),
  at[1] + north / 111320,
];

/** Shader-time changes never rebuild geometry or the fixture texture. */
export const festivePulse = (time: number, seed: number, reducedMotion = false) =>
  reducedMotion ? 1 : 0.88 + 0.12 * Math.sin(time * (1.2 + (seed & 31) * 0.021) + (seed & 31));
export const festivePulseGlsl = `float festivePulse(int seed) { return u_shimmer ? 0.88 + 0.12 * sin(u_time * (1.2 + float(seed) * 0.021) + float(seed)) : 1.0; }`;

export function installationLamps(
  fixtures: readonly InstallationFixture[],
  zoom: number,
): VisibleLamp[] {
  if (zoom < 18) return [];
  return fixtures.map(({ record: r }) => {
    const at: [number, number] =
      r.kind === 'light-string' ? [(r.from[0] + r.to[0]) / 2, (r.from[1] + r.to[1]) / 2] : r.at;
    const radius = r.kind === 'light-string' ? 2 : r.radius_m + 1;
    return {
      lng: at[0],
      lat: at[1],
      center: at,
      pool: at,
      east: metric(at, radius, 0),
      north: metric(at, 0, radius),
      state: LampState.flood,
      seed: r.seed & 31,
    };
  });
}

type Write = (
  x: number,
  y: number,
  glyph: string,
  part: number,
  info: number,
  replace?: boolean,
) => boolean;
/** Bounded metric footprints, viewed from above; cords occupy gaps between ornaments. */
export function packInstallation(
  record: InstallationRecord,
  grid: FixtureGrid,
  write: Write,
): boolean {
  let visible = false;
  const put = (
    x: number,
    y: number,
    glyph: string,
    part: number,
    info: number,
    replace = false,
  ) => {
    visible = write(x, y, glyph, part, info, replace) || visible;
  };
  if (record.kind === 'light-string') {
    const a = grid.toCell(...record.from),
      b = grid.toCell(...record.to),
      dx = b[0] - a[0],
      dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length > 100000) return false;
    // Always sample from complete world endpoints: panning/clipping cannot restart the pattern.
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
    const cable =
      Math.abs(dx) > Math.abs(dy) * 1.8
        ? '─'
        : Math.abs(dy) > Math.abs(dx) * 1.8
          ? '│'
          : dx * dy > 0
            ? '╲'
            : '╱';
    for (let i = 0; i <= n; i++) {
      const x = a[0] + (dx * i) / n,
        y = a[1] + (dy * i) / n;
      if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
      put(
        x,
        y,
        cable,
        record.mount === 'building' ? SeasonalPart.buildingWire : SeasonalPart.festiveWire,
        0,
      );
    }
    const meters = Math.hypot(
      (record.to[0] - record.from[0]) * 111320 * Math.cos((record.from[1] * Math.PI) / 180),
      (record.to[1] - record.from[1]) * 111320,
    );
    const count = Math.max(1, Math.floor(meters / 1.8));
    for (let i = 0; i <= count; i++) {
      const glyph =
        i % 3 === 0 ? SEASONAL_GLYPHS[0] : i % 3 === 1 ? SEASONAL_GLYPHS[7] : SEASONAL_GLYPHS[6];
      put(
        a[0] + (dx * i) / count,
        a[1] + (dy * i) / count,
        glyph,
        record.mount === 'building'
          ? SeasonalPart.buildingLight
          : record.mount === 'canopy'
            ? SeasonalPart.festiveLight
            : SeasonalPart.festiveOrnament,
        (((record.seed + i) & 31) << 3) | (i % 3 === 0 ? 5 : 0),
        true,
      );
    }
  } else {
    const center = grid.toCell(...record.at),
      east = grid.toCell(...metric(record.at, record.radius_m, 0)),
      north = grid.toCell(...metric(record.at, 0, record.radius_m));
    const rx = Math.max(0.6, Math.abs(east[0] - center[0])),
      ry = Math.max(0.6, Math.abs(north[1] - center[1]));
    if (!Number.isFinite(rx + ry) || rx * ry > 100000) return false;
    if (record.kind === 'christmas-tree') {
      for (
        let y = Math.max(0, Math.floor(center[1] - ry));
        y <= Math.min(grid.rows - 1, Math.ceil(center[1] + ry));
        y++
      )
        for (
          let x = Math.max(0, Math.floor(center[0] - rx));
          x <= Math.min(grid.cols - 1, Math.ceil(center[0] + rx));
          x++
        ) {
          const d = Math.hypot((x + 0.5 - center[0]) / rx, (y + 0.5 - center[1]) / ry);
          if (d <= 1)
            put(x, y, SEASONAL_GLYPHS[5], SeasonalPart.festiveTree, Math.round((1 - d) * 255));
        }
    }
    const tiers = record.kind === 'christmas-tree' ? [0.35, 0.68, 0.94] : [0.62, 0.94];
    for (const tier of tiers) {
      const count = Math.max(8, Math.ceil((2 * Math.PI * record.radius_m * tier) / 1.5));
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + (record.seed & 31) * 0.05;
        const at = grid.toCell(
          ...metric(
            record.at,
            Math.cos(angle) * record.radius_m * tier,
            Math.sin(angle) * record.radius_m * tier,
          ),
        );
        const glyph =
          record.kind === 'decorated-canopy' && i % 4 === 0
            ? SEASONAL_GLYPHS[0]
            : SEASONAL_GLYPHS[6];
        put(
          at[0],
          at[1],
          glyph,
          SeasonalPart.festiveLight,
          (((record.seed + i) & 31) << 3) | ((i + record.seed) % 6),
          true,
        );
      }
    }
    if (record.kind === 'christmas-tree')
      put(
        center[0],
        center[1],
        SEASONAL_GLYPHS[0],
        SeasonalPart.festiveOrnament,
        (record.seed & 31) << 3,
        true,
      );
  }
  return visible;
}

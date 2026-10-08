import { offsetUtility, type SeasonalCarnivalRecord } from '@atlas/shared';
import { SeasonalPart } from './seasonal-glyphs';
import { carnivalExtraTime, type CarnivalBoost } from './carnival-motion';

export const MAX_CARNIVAL_BOOSTS = 48;
export const carnivalKey = (r: SeasonalCarnivalRecord) => `${r.season}/${r.installation}/${r.id}`;
export type CarnivalUniforms = { count: number; centers: Float32Array; axes: Float32Array };
type Project = (lng: number, lat: number) => [number, number];
export function carnivalFootprint(r: SeasonalCarnivalRecord, toCell: Project) {
  const center = toCell(...r.at),
    angle = (r.angle_deg * Math.PI) / 180;
  const x = toCell(
    ...offsetUtility(
      r.at,
      (Math.cos(angle) * r.size_m[0]) / 2,
      (Math.sin(angle) * r.size_m[0]) / 2,
    ),
  );
  const y = toCell(
    ...offsetUtility(
      r.at,
      (-Math.sin(angle) * r.size_m[1]) / 2,
      (Math.cos(angle) * r.size_m[1]) / 2,
    ),
  );
  return { center, axes: [x[0] - center[0], x[1] - center[1], y[0] - center[0], y[1] - center[1]] };
}
/** Same rotated rectangle/circle used when packing the ride's motion cells. */
export function carnivalContains(
  r: SeasonalCarnivalRecord,
  point: readonly [number, number],
  toCell: Project,
) {
  const {
    center,
    axes: [ex, ey, nx, ny],
  } = carnivalFootprint(r, toCell);
  const p = toCell(...point),
    dx = p[0] - center[0],
    dy = p[1] - center[1],
    det = ex! * ny! - ey! * nx!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return false;
  const u = (dx * ny! - dy * nx!) / det,
    v = (ex! * dy - ey! * dx) / det;
  return Math.abs(u) <= 1 && Math.abs(v) <= 1 && (r.style !== 'carousel' || u * u + v * v <= 1);
}
export class CarnivalBoosts {
  private readonly centers = new Float32Array(MAX_CARNIVAL_BOOSTS * 4);
  private readonly axes = new Float32Array(MAX_CARNIVAL_BOOSTS * 4);
  private readonly rides = new Map<
    string,
    { record: SeasonalCarnivalRecord; boost: CarnivalBoost }
  >();
  request(record: SeasonalCarnivalRecord, time: number) {
    const key = carnivalKey(record),
      previous = this.rides.get(key);
    if (!previous && this.rides.size >= MAX_CARNIVAL_BOOSTS) return;
    this.rides.set(key, {
      record,
      boost: { at: time, offset: previous ? carnivalExtraTime(previous.boost, time) : 0 },
    });
  }
  time(key: string, time: number) {
    const r = this.rides.get(key);
    return time + (r ? carnivalExtraTime(r.boost, time) : 0);
  }
  uniforms(time: number, toCell: Project): CarnivalUniforms {
    const { centers, axes } = this;
    let count = 0;
    for (const { record, boost } of this.rides.values()) {
      const footprint = carnivalFootprint(record, toCell),
        part =
          record.style === 'carousel'
            ? SeasonalPart.carouselMotion
            : record.style === 'ferris-wheel'
              ? SeasonalPart.wheelMotion
              : SeasonalPart.bumperMotion;
      const offset = count * 4;
      centers[offset] = footprint.center[0];
      centers[offset + 1] = footprint.center[1];
      centers[offset + 2] = carnivalExtraTime(boost, time);
      centers[offset + 3] = part;
      axes.set(footprint.axes, offset);
      count++;
    }
    return { count, centers, axes };
  }
}

import { carnivalRing, offsetUtility, type SeasonalCarnivalRecord } from '@atlas/shared';
import type { FixtureGrid } from './fixtures';
import { SeasonalGlyph, SeasonalPart } from './seasonal-glyphs';
import { encodeCarnivalUv, isCarnivalMotionPart } from './carnival-motion';

const BOOTH_TINTS = [1, 2, 3, 4] as const;
const CANOPY_TINTS = [0, 1, 2, 0, 3, 5] as const;

type Write = (
  x: number,
  y: number,
  glyph: string,
  part: number,
  info: number,
  replace?: boolean,
) => boolean;
/** North-up ride roofs/decks, never an upright illustration pasted onto the map. */
export function packCarnival(r: SeasonalCarnivalRecord, grid: FixtureGrid, write: Write): boolean {
  const center = grid.toCell(...r.at),
    east = grid.toCell(...offsetUtility(r.at, 1, 0)),
    north = grid.toCell(...offsetUtility(r.at, 0, 1));
  const ex = east[0] - center[0],
    ey = east[1] - center[1],
    nx = north[0] - center[0],
    ny = north[1] - center[1];
  const det = ex * ny - ey * nx;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return false;
  const corners = carnivalRing(r).map((p) => grid.toCell(...p));
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[0])))),
    x1 = Math.min(grid.cols - 1, Math.ceil(Math.max(...corners.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p[1])))),
    y1 = Math.min(grid.rows - 1, Math.ceil(Math.max(...corners.map((p) => p[1]))));
  if (!Number.isFinite(x0 + x1 + y0 + y1) || (x1 - x0 + 1) * (y1 - y0 + 1) > 200000) return false;
  const a = (r.angle_deg * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  const w = r.size_m[0] / 2,
    h = r.size_m[1] / 2;
  let visible = false;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - center[0],
        dy = y + 0.5 - center[1];
      const e = (dx * ny - dy * nx) / det,
        n = (ex * dy - ey * dx) / det;
      const u = e * cos + n * sin,
        v = -e * sin + n * cos;
      if (Math.abs(u) > w || Math.abs(v) > h) continue;
      let glyph = '█',
        part: number = SeasonalPart.carnivalRoof,
        tint = 0;
      const edge = Math.min(w - Math.abs(u), h - Math.abs(v));
      if (r.style === 'midway') {
        const aisle = (w * 2) / 9;
        glyph = '░';
        part = SeasonalPart.carnivalGround;
        tint = 0;
        // A broad central walkway connects the southern entrance and both ride areas.
        if (Math.abs(u - aisle) < Math.min(1.5, w / 4) || Math.abs(v) < 2) {
          glyph = '▒';
          tint = 1;
        }
        // Sagging overhead festoons fill the open midway without adding obstacles.
        // Metric coordinates keep every strand and bulb fixed during camera repacks.
        const sag = 1.3 * (1 - (u / w) ** 2);
        const row = Math.round((v + h - 2 - sag) / 4.5);
        if (Math.abs(v + h - 2 - sag - row * 4.5) < 0.55) {
          const bulb = Math.round((u + w) / 1.6);
          if (Math.abs(u + w - bulb * 1.6) < 0.55) {
            glyph = bulb % 7 === 3 ? SeasonalGlyph.parol : SeasonalGlyph.bulb;
            part = SeasonalPart.carnivalLight;
            tint = CANOPY_TINTS[(((bulb + row) % 6) + 6) % 6]!;
          }
        }
        if (edge < 0.75) {
          glyph = SeasonalGlyph.bulb;
          part = SeasonalPart.carnivalLight;
          tint = Math.floor((u + v + w + h) / 2) % 4 === 0 ? 1 : 0;
        }
        if (v < -h + 1 && Math.abs(u - aisle) < Math.min(4.5, w / 3)) {
          glyph = SeasonalGlyph.parol;
          part = SeasonalPart.carnivalLight;
          tint = 0;
        }
      } else if (r.style === 'carousel') {
        const radius = Math.hypot(u, v);
        if (radius > w) continue;
        part = SeasonalPart.carouselMotion;
        if (radius > w - 0.8 || Math.abs(radius - w * 0.55) < 0.3) {
          glyph = SeasonalGlyph.bulb;
          part = SeasonalPart.carnivalLight;
          tint = radius > w - 0.8 ? 0 : 5;
        }
        if (radius < 0.8) {
          glyph = SeasonalGlyph.parol;
          part = SeasonalPart.carnivalLight;
          tint = 5;
        }
      } else if (r.style === 'booth') {
        tint = Math.floor((u + w) / 1.1) % 2 ? BOOTH_TINTS[r.seed % 4]! : 0;
        if (edge < 0.5 || v < -h + 0.8) {
          glyph = SeasonalGlyph.bulb;
          part = SeasonalPart.carnivalLight;
          tint = v < -h + 0.8 ? 5 : BOOTH_TINTS[r.seed % 4]!;
        }
      } else if (r.style === 'bumper-cars') {
        part = SeasonalPart.bumperMotion;
        if (edge < 0.8) {
          glyph = SeasonalGlyph.bulb;
          part = SeasonalPart.carnivalLight;
          tint = Math.floor((u + v + w + h) / 2) % 2 ? 3 : 2;
        }
      } else {
        // From overhead a vertical wheel is a narrow rim between its two support gantries.
        part = SeasonalPart.wheelMotion;
        if (edge < 0.5) {
          glyph = SeasonalGlyph.bulb;
          part = SeasonalPart.carnivalLight;
          tint = Math.floor((v + h) / 2) % 2 ? 5 : 2;
        }
      }
      const info = isCarnivalMotionPart(part)
        ? encodeCarnivalUv(u / w, v / h)
        : part === SeasonalPart.carnivalLight
          ? (((r.seed + Math.floor(v + h)) & 31) << 3) | tint
          : tint;
      visible = write(x, y, glyph, part, info, true) || visible;
    }
  return visible;
}

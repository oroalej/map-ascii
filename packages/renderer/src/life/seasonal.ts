/** Cached seasonal hardware and shared proximity queries. All city-specific choices come from the pack. */
import {
  DEFAULT_ROAD_WIDTH_M,
  bandVisibility,
  type PlaceKind,
  type SeasonConfig,
  type UtilityRecord,
  type UtilitySpan,
  type SeasonalRecord,
  type SeasonalBuntingRecord,
} from '@atlas/shared';
import {
  EXTENT,
  MERCATOR_METERS,
  lngLatToTile,
  metersPerUnit,
  tileToLngLat,
} from '../raster/geometry';
import type { TileId } from '../tiles';
import { LifeLine, PLACE_CODES, PLACE_STRIDE, type LifeGeometry } from './geometry';
import type { FixtureGrid, LegacyStreetFixture, StreetFixture } from './fixtures';
import { lightByte, LampState, placeSeed } from './lights';
import { clipUtilityLine } from './utilities';
import { MAX_GLYPHS, packGlyph } from '../glyphs/select';
import { isCarnivalMotionPart } from './carnival-motion';
import { buntingWidth, selectBuntingRows, type BuntingPriority } from './bunting-junctions';
import {
  admitsInstallation,
  packInstallation,
  type InstallationFixture,
} from './seasonal-installations';

type Point = [number, number];
import { SeasonalPart, SeasonalGlyph } from './seasonal-glyphs';
export { SeasonalPart, SeasonalGlyph } from './seasonal-glyphs';
export type SeasonalFixture =
  | InstallationFixture
  | { kind: 'season-lantern'; lamp: Extract<LegacyStreetFixture, { kind: 'streetlight' }> }
  | {
      kind: 'season-bunting';
      id: string;
      from: Point;
      to: Point;
      seed: number;
      style?: 'red-yellow-rectangles';
      priority?: BuntingPriority;
    };
export type SeasonalVisibility = { lanterns: boolean; bunting: boolean; installations?: boolean };
export function isSeasonalFixture(fixture: StreetFixture): fixture is SeasonalFixture {
  return (
    fixture.kind === 'season-lantern' ||
    fixture.kind === 'season-bunting' ||
    fixture.kind === 'season-installation'
  );
}
export type SeasonalTile = {
  tile: TileId;
  life: LifeGeometry;
  fixtures: readonly LegacyStreetFixture[];
  utilities?: readonly UtilityRecord[];
  seasonal?: readonly SeasonalRecord[];
};
export type SeasonAnchor = { at: Point; kind: PlaceKind | 'market' };
type Geography = Pick<SeasonalTile, 'tile' | 'life'>;

/** Place centers are tile-owned, so neighboring tiles must contribute their anchors too. */
export function collectSeasonAnchors(tiles: readonly Geography[]): SeasonAnchor[] {
  const found = new Map<string, SeasonAnchor>();
  const add = (tile: TileId, x: number, y: number, kind: SeasonAnchor['kind']) => {
    const at = tileToLngLat(tile, { x, y });
    found.set(`${kind}/${at[0].toFixed(7)}/${at[1].toFixed(7)}`, { at, kind });
  };
  for (const { tile, life } of tiles) {
    for (let i = 0; i < life.places.length; i += PLACE_STRIDE) {
      const kind = PLACE_CODES[life.places[i + 2]!];
      if (kind) add(tile, life.places[i]!, life.places[i + 1]!, kind);
    }
    for (let i = 0; i < life.markets.length; i += 2)
      add(tile, life.markets[i]!, life.markets[i + 1]!, 'market');
  }
  return [...found.values()];
}

/** Prepare the metric filter once per tile/config, rather than projecting anchors per candidate. */
export function seasonProximity(
  tile: TileId,
  anchors: readonly SeasonAnchor[],
  near: readonly PlaceKind[] | undefined,
  radius: number | undefined,
  markets = false,
) {
  if (!near) return () => true;
  const points = anchors
    .filter((a) => (a.kind === 'market' ? markets : near.includes(a.kind)))
    .map((a) => lngLatToTile(tile, ...a.at));
  const reach2 = ((radius ?? 0) / metersPerUnit(tile)) ** 2;
  return (x: number, y: number) => points.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= reach2);
}

/** A fixed reference latitude keeps the world lattice identical across adjacent tile rows. */
function fallbackBunting(
  group: SeasonalTile,
  config: NonNullable<SeasonConfig['bunting']>,
  near: (x: number, y: number) => boolean,
  latitude: number,
  covered: ReadonlySet<number>,
): SeasonalFixture[] {
  const { tile, life } = group;
  const groundScale =
    (MERCATOR_METERS / (EXTENT * 2 ** tile.z)) * Math.cos((latitude * Math.PI) / 180);
  const step = config.spacing_m / groundScale;
  const result: SeasonalFixture[] = [];
  for (let line = 0; line < life.kinds.length; line++) {
    if (life.kinds[line]! > LifeLine.roadMinor || covered.has(line)) continue;
    const reach = ((life.widths[line] || DEFAULT_ROAD_WIDTH_M) / 2 + 0.5) / metersPerUnit(tile);
    for (let v = life.starts[line]! + 1; v < life.starts[line + 1]!; v++) {
      const ax = life.coords[(v - 1) * 2]!,
        ay = life.coords[(v - 1) * 2 + 1]!;
      const dx = life.coords[v * 2]! - ax,
        dy = life.coords[v * 2 + 1]! - ay;
      const length = Math.hypot(dx, dy);
      if (!length) continue;
      const across = Math.abs(dx) >= Math.abs(dy);
      const from = across ? tile.x * EXTENT + ax : tile.y * EXTENT + ay;
      const to = from + (across ? dx : dy);
      for (
        let n = Math.ceil(Math.min(from, to) / step);
        n <= Math.floor(Math.max(from, to) / step);
        n++
      ) {
        const u = (n * step - from) / (to - from);
        if (u < 0 || u >= 1) continue;
        const x = ax + dx * u,
          y = ay + dy * u;
        if (x < 0 || x >= EXTENT || y < 0 || y >= EXTENT || !near(x, y)) continue;
        const nx = -dy / length,
          ny = dx / length;
        const worldX = (tile.x * EXTENT + x) * groundScale,
          worldY = (tile.y * EXTENT + y) * groundScale;
        result.push({
          kind: 'season-bunting',
          id: `fallback/${worldX.toFixed(3)}/${worldY.toFixed(3)}`,
          from: tileToLngLat(tile, { x: x - nx * reach, y: y - ny * reach }),
          to: tileToLngLat(tile, { x: x + nx * reach, y: y + ny * reach }),
          seed: placeSeed(worldX, worldY) & 31,
        });
      }
    }
  }
  return result;
}

type Coverage = { a: Point; dx: number; dy: number; length2: number; halfWidth: number };
const corridorGeometry = new WeakMap<SeasonalBuntingRecord, Coverage>();
/** One world-space index for all contributing tiles; include reach and buffered segments. */
function buntingCoverage(
  records: Iterable<SeasonalBuntingRecord>,
  groups: readonly SeasonalTile[],
) {
  const cell = 2 ** -18;
  const spatial = new Map<number, Map<number, Coverage[]>>();
  let padding = 0;
  for (const { tile } of groups)
    padding = Math.max(padding, 1 / (metersPerUnit(tile) * EXTENT * 2 ** tile.z));
  const world = (p: Point): Point => {
    const q = lngLatToTile({ z: 0, x: 0, y: 0 }, ...p);
    return [q.x / EXTENT, q.y / EXTENT];
  };
  for (const record of records) {
    let c = corridorGeometry.get(record);
    if (!c) {
      const a = world(record.segment[0]),
        b = world(record.segment[1]);
      const from = world(record.from),
        to = world(record.to);
      const dx = b[0] - a[0],
        dy = b[1] - a[1];
      c = {
        a,
        dx,
        dy,
        length2: dx * dx + dy * dy,
        halfWidth: Math.hypot(to[0] - from[0], to[1] - from[1]) / 2,
      };
      corridorGeometry.set(record, c);
    }
    if (!c.length2) continue;
    const reach = c.halfWidth + padding;
    const x0 = Math.floor((Math.min(c.a[0], c.a[0] + c.dx) - reach) / cell);
    const x1 = Math.floor((Math.max(c.a[0], c.a[0] + c.dx) + reach) / cell);
    const y0 = Math.floor((Math.min(c.a[1], c.a[1] + c.dy) - reach) / cell);
    const y1 = Math.floor((Math.max(c.a[1], c.a[1] + c.dy) + reach) / cell);
    for (let x = x0; x <= x1; x++) {
      let column = spatial.get(x);
      if (!column) spatial.set(x, (column = new Map<number, Coverage[]>()));
      for (let y = y0; y <= y1; y++) {
        let bucket = column.get(y);
        if (!bucket) column.set(y, (bucket = []));
        bucket.push(c);
      }
    }
  }
  return (tile: TileId) => {
    const scale = 2 ** tile.z,
      margin = 1 / (metersPerUnit(tile) * EXTENT * scale);
    return (x: number, y: number) => {
      const wx = (tile.x + x / EXTENT) / scale,
        wy = (tile.y + y / EXTENT) / scale;
      for (const c of spatial.get(Math.floor(wx / cell))?.get(Math.floor(wy / cell)) ?? []) {
        const dx = wx - c.a[0],
          dy = wy - c.a[1];
        const u = (dx * c.dx + dy * c.dy) / c.length2;
        if (
          u >= 0 &&
          u <= 1 &&
          (dx - u * c.dx) ** 2 + (dy - u * c.dy) ** 2 <= (c.halfWidth + margin) ** 2
        )
          return true;
      }
      return false;
    };
  };
}

export function seasonalFixtures(
  groups: readonly SeasonalTile[],
  season: SeasonConfig | undefined,
  latitude: number,
  buntingVisible = true,
): SeasonalFixture[] {
  if (!season) return [];
  const anchors = collectSeasonAnchors(groups);
  const result: SeasonalFixture[] = [];
  const corridors = new Map(season.bunting?.corridors?.map((c) => [c.id, c]));
  const displays = new Map<string, InstallationFixture>();
  const dense = new Map<string, SeasonalBuntingRecord>();
  for (const group of groups)
    for (const r of group.seasonal ?? []) {
      if (r.kind !== 'bunting' && admitsInstallation(r, season))
        displays.set(r.id, { kind: 'season-installation', record: r });
      else if (
        r.kind === 'bunting' &&
        buntingVisible &&
        r.season === season.id &&
        corridors.get(r.corridor)?.ways.includes(r.road)
      )
        dense.set(r.id, r);
    }
  const segments = new Map<string, SeasonalBuntingRecord>();
  for (const r of dense.values()) segments.set(JSON.stringify(r.segment), r);
  const coveredByDense = buntingCoverage(segments.values(), groups);
  const spans = new Map<string, UtilitySpan>();
  for (const group of groups)
    for (const record of group.utilities ?? [])
      if (
        buntingVisible &&
        season.bunting &&
        record.kind === 'span' &&
        record.span.kind === 'crossing'
      )
        spans.set(record.span.id, record.span);
  const bunting = new Map<string, Extract<SeasonalFixture, { kind: 'season-bunting' }>>();
  for (const group of groups) {
    if (season.lanterns) {
      const near = seasonProximity(
        group.tile,
        anchors,
        season.lanterns.near,
        season.lanterns.radius_m,
      );
      for (const lamp of group.fixtures)
        if (lamp.kind === 'streetlight') {
          const p = lngLatToTile(group.tile, ...lamp.base);
          if (near(p.x, p.y)) result.push({ kind: 'season-lantern', lamp });
        }
    }
    if (!season.bunting || !buntingVisible) continue;
    const baseNear = seasonProximity(
      group.tile,
      anchors,
      season.bunting.near,
      season.bunting.radius_m,
    );
    const coveredHere = coveredByDense(group.tile);
    const near = (x: number, y: number) => baseNear(x, y) && !coveredHere(x, y);
    const covered = new Set<number>();
    for (const span of spans.values()) {
      const at: Point = [
        (span.from.at[0] + span.to.at[0]) / 2,
        (span.from.at[1] + span.to.at[1]) / 2,
      ];
      const p = lngLatToTile(group.tile, ...at);
      if (p.x < 0 || p.x >= EXTENT || p.y < 0 || p.y >= EXTENT || !near(p.x, p.y)) continue;
      // A crossing on one road must not suppress decorations on every other
      // road in this tile. Prefer carriers only on the road they actually cross.
      let closest = -1,
        distance = Infinity;
      for (let line = 0; line < group.life.kinds.length; line++) {
        if (group.life.kinds[line]! > LifeLine.roadMinor) continue;
        for (let v = group.life.starts[line]! + 1; v < group.life.starts[line + 1]!; v++) {
          const ax = group.life.coords[(v - 1) * 2]!,
            ay = group.life.coords[(v - 1) * 2 + 1]!;
          const dx = group.life.coords[v * 2]! - ax,
            dy = group.life.coords[v * 2 + 1]! - ay;
          const length2 = dx * dx + dy * dy;
          if (!length2) continue;
          const u = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / length2));
          const d = (p.x - ax - dx * u) ** 2 + (p.y - ay - dy * u) ** 2;
          if (d < distance) {
            distance = d;
            closest = line;
          }
        }
      }
      if (
        closest >= 0 &&
        distance <=
          (((group.life.widths[closest] || DEFAULT_ROAD_WIDTH_M) / 2 + 2) /
            metersPerUnit(group.tile)) **
            2
      )
        covered.add(closest);
      bunting.set(span.id, {
        kind: 'season-bunting',
        id: span.id,
        from: span.from.at,
        to: span.to.at,
        seed: span.seed & 31,
      });
    }
    for (const fixture of fallbackBunting(group, season.bunting, near, latitude, covered))
      if (fixture.kind === 'season-bunting') bunting.set(fixture.id, fixture);
  }
  for (const r of dense.values())
    bunting.set(r.id, {
      kind: 'season-bunting',
      id: r.id,
      from: r.from,
      to: r.to,
      seed: r.seed & 31,
      style: 'red-yellow-rectangles',
      priority: {
        width: buntingWidth(r.from, r.to),
        corridor: season.bunting!.corridors!.findIndex((c) => c.id === r.corridor),
        road: r.road,
      },
    });
  // Derive priority once with the cached fixture set. Coverage above deliberately includes
  // every decoded dense segment, even when its row will be rejected at a junction.
  if (corridors.size)
    for (const fixture of bunting.values())
      fixture.priority ??= {
        width: buntingWidth(fixture.from, fixture.to),
        corridor: Infinity,
        road: fixture.id,
      };
  result.push(...[...bunting.values()].sort((a, b) => a.id.localeCompare(b.id)));
  result.push(
    ...[...displays.values()].sort(
      (a, b) =>
        Number(!(a.record.kind === 'carnival' && a.record.style === 'midway')) -
          Number(!(b.record.kind === 'carnival' && b.record.style === 'midway')) ||
        a.record.id.localeCompare(b.record.id),
    ),
  );
  return result;
}

/** Only the current contributing set is retained; payload/config changes invalidate the cache. */
export function createSeasonalFixtureCache() {
  let previous: readonly SeasonalTile[] = [],
    previousSeason: SeasonConfig | undefined,
    previousBunting = true,
    previousLatitude = NaN;
  let result: SeasonalFixture[] = [];
  return (
    groups: readonly SeasonalTile[],
    season: SeasonConfig | undefined,
    latitude: number,
    buntingVisible = true,
  ) => {
    if (!season && !previousSeason) return result;
    if (
      season === previousSeason &&
      buntingVisible === previousBunting &&
      latitude === previousLatitude &&
      groups.length === previous.length &&
      groups.every((g, i) => {
        const p = previous[i]!;
        return (
          g.life === p.life &&
          g.fixtures === p.fixtures &&
          g.utilities === p.utilities &&
          g.seasonal === p.seasonal &&
          g.tile.z === p.tile.z &&
          g.tile.x === p.tile.x &&
          g.tile.y === p.tile.y
        );
      })
    )
      return result;
    previous = season ? groups.slice() : [];
    previousSeason = season;
    previousLatitude = latitude;
    previousBunting = buntingVisible;
    result = seasonalFixtures(groups, season, latitude, buntingVisible);
    return result;
  };
}

const surfaceOrderCache = new WeakMap<readonly SeasonalFixture[], readonly SeasonalFixture[]>();
/** Add decorations after all existing hardware; reserved flag envelopes remain untouched. */
export function packSeasonalFixtures(
  out: Uint8Array,
  grid: FixtureGrid,
  fixtures: readonly SeasonalFixture[],
  zoom: number,
  glyphIndex: (glyph: string) => number,
  owners: Int32Array,
): SeasonalVisibility {
  const visibility: SeasonalVisibility = { lanterns: false, bunting: false };
  const rows = bandVisibility({ min: 18 }, zoom) ? selectBuntingRows(fixtures, grid) : undefined;
  const write = (
    x: number,
    y: number,
    glyph: string,
    part: number,
    info: number,
    alpha: number,
    replace = false,
  ): boolean => {
    const c = Math.floor(x),
      r = Math.floor(y);
    if (!Number.isFinite(x + y) || c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
    const cell = r * grid.cols + c,
      at = cell * 4,
      motion = isCarnivalMotionPart(part),
      index = motion ? info >>> 8 : glyphIndex(glyph);
    if (
      (!replace && (owners[cell] !== -1 || out[at + 3])) ||
      (replace && owners[cell] !== -1 && owners[cell] !== -5) ||
      (index <= 0 && !motion) ||
      index > MAX_GLYPHS
    )
      return false;
    [out[at], out[at + 1]] = packGlyph(index, part);
    out[at + 2] = info;
    out[at + 3] = alpha;
    owners[cell] = -3;
    return !grid.visible || grid.visible(c, r);
  };
  // Lay paving below decorations, independently of buffered tile/record ordering.
  let ordered = surfaceOrderCache.get(fixtures);
  if (!ordered) {
    const surfaces = fixtures.filter(
      (f) => f.kind === 'season-installation' && f.record.kind === 'access-path',
    );
    ordered = surfaces.length
      ? [...surfaces, ...fixtures.filter((f) => !surfaces.includes(f))]
      : fixtures;
    surfaceOrderCache.set(fixtures, ordered);
  }
  for (const fixture of ordered) {
    const min = fixture.kind === 'season-lantern' ? 17 : 18;
    const alpha = Math.round(bandVisibility({ min }, zoom) * 255);
    if (!alpha) continue;
    if (fixture.kind === 'season-installation') {
      visibility.installations =
        packInstallation(fixture.record, grid, (x, y, glyph, part, info, replace) => {
          const c = Math.floor(x),
            r = Math.floor(y);
          const valid = c >= 0 && r >= 0 && c < grid.cols && r < grid.rows;
          const before = valid ? owners[r * grid.cols + c] : undefined;
          const ok = write(x, y, glyph, part, info, alpha, replace);
          if (valid && (before === -1 || before === -5) && owners[r * grid.cols + c] === -3)
            owners[r * grid.cols + c] = -5;
          return ok;
        }) || visibility.installations === true;
      continue;
    }
    if (fixture.kind === 'season-lantern') {
      const { lamp } = fixture;
      const at = grid.toCell(...lamp.tip),
        base = grid.toCell(...lamp.base),
        forward = grid.toCell(...lamp.forward);
      const dx = forward[0] - base[0],
        dy = forward[1] - base[1],
        length = Math.hypot(dx, dy) || 1;
      for (let n = 1; n <= 10; n++) {
        const x = at[0] + (dx / length) * n,
          y = at[1] + (dy / length) * n;
        const cell = Math.floor(y) * grid.cols + Math.floor(x);
        if (
          Math.floor(x) < 0 ||
          Math.floor(x) >= grid.cols ||
          Math.floor(y) < 0 ||
          Math.floor(y) >= grid.rows
        )
          continue;
        if (owners[cell] !== -1 || out[cell * 4 + 3]) continue;
        visibility.lanterns =
          write(
            x,
            y,
            SeasonalGlyph.parol,
            SeasonalPart.lantern,
            lightByte(LampState.candle, lamp.seed),
            alpha,
          ) || visibility.lanterns;
        break;
      }
    } else {
      const row = rows?.get(fixture);
      if (!row) continue;
      const clipped = clipUtilityLine(row.from, row.to, grid.cols, grid.rows);
      if (!clipped) continue;
      const dense = fixture.style === 'red-yellow-rectangles';
      const [a, b]: [Point, Point] = dense ? [row.from, row.to] : clipped,
        spanX = b[0] - a[0],
        spanY = b[1] - a[1];
      const count = Math.max(1, Math.ceil(Math.max(Math.abs(spanX), Math.abs(spanY))));
      const axis = Math.abs(spanX) >= Math.abs(spanY) ? 0 : 1;
      const delta = axis === 0 ? spanX : spanY;
      const start =
        dense && delta ? Math.max(0, Math.ceil(((clipped[0][axis] - a[axis]) / delta) * count)) : 0;
      const end =
        dense && delta
          ? Math.min(count, Math.floor(((clipped[1][axis] - a[axis]) / delta) * count))
          : count;
      for (let n = start; n <= end; n++)
        visibility.bunting =
          write(
            a[0] + (spanX * n) / count,
            a[1] + (spanY * n) / count,
            dense
              ? (n + fixture.seed) & 1
                ? SeasonalGlyph.rectangleRight
                : SeasonalGlyph.rectangleLeft
              : (n + fixture.seed) & 1
                ? SeasonalGlyph.triangleRight
                : SeasonalGlyph.triangleLeft,
            SeasonalPart.bunting,
            ((fixture.seed & 31) << 3) |
              (dense ? (n + fixture.seed) & 1 : (Math.floor(n / 2) + fixture.seed) % 3),
            alpha,
          ) || visibility.bunting;
    }
  }
  return visibility;
}

export { SEASONAL_GLYPHS } from './seasonal-glyphs';

import earcut from 'earcut';
import { EXTENT, insidePolygon, type TilePoint } from '../raster/geometry';
import type { TileId } from '../tiles';
import { frameBetween } from './frames';
import {
  inTile,
  LifeLine,
  PLACE_CODES,
  PLACE_STRIDE,
  TILE_QUANTIZATION_TOLERANCE,
  type LifeGeometry,
} from './geometry';
import { hashString, random } from './random';
import { FOLKLORE } from './folklore-config';

export type Point = { x: number; y: number };
export type FolkloreTile = {
  key: string;
  tile: TileId;
  geo: LifeGeometry;
  perMeter: number;
  owns(p: Point): boolean;
};
export type Fragment = { source: FolkloreTile; rings: TilePoint[][] };
export type Site = {
  id: string;
  kind: 'cemetery' | 'worship' | 'hospital';
  at: Point;
  radius: number;
  fragments?: Fragment[];
};
export type RoofAnchor = { id: string; at: Point };
export type Candidate = {
  id: string;
  kind: 'farmland' | 'grass';
  lower: Point;
  centre: RoofAnchor;
};
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const mixPoint = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export function nearestOnSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
  );
  return { at: mixPoint(a, b, t), t };
}

/** Endpoint containment cannot catch a concave excursion or crossing a cemetery hole. */
export function segmentInside(rings: readonly (readonly Point[])[], a: Point, b: Point): boolean {
  if (!insidePolygon(rings, a) || !insidePolygon(rings, b)) return false;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i]!,
        d = ring[(i + 1) % ring.length]!,
        ex = d.x - c.x,
        ey = d.y - c.y;
      const cross = dx * ey - dy * ex;
      if (Math.abs(cross) < 1e-10) continue;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
      const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
      if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) return false;
    }
  return insidePolygon(rings, mixPoint(a, b, 0.5));
}

/** Cached read-only geometry in a fixed world metric frame; no agent state is retained here. */
export class FolkloreGeometry {
  readonly sites: Site[] = [];
  readonly roofs: RoofAnchor[] = [];
  readonly candidates: Candidate[] = [];
  private fields = new Map<string, (Fragment & { kind: Candidate['kind'] })[]>();
  private roofFragments = new Map<string, Fragment[]>();
  constructor(
    readonly sources: readonly FolkloreTile[],
    readonly ref: Pick<FolkloreTile, 'tile' | 'perMeter'>,
  ) {
    const cemeteries = new Map<string, Fragment[]>(),
      sites = new Map<string, Site>(),
      roofs = new Map<string, RoofAnchor>();
    const ordered = [...sources].sort((a, b) => b.tile.z - a.tile.z || a.key.localeCompare(b.key));
    for (const source of ordered) {
      for (const area of source.geo.cemeteryAreas ?? []) {
        const fragment = { source, rings: area.rings };
        if (!this.interior(fragment, hashString(area.id))) continue;
        const fragments = cemeteries.get(area.id) ?? [];
        fragments.push(fragment);
        cemeteries.set(area.id, fragments);
      }
      const worship = new Map(source.geo.worshipIds);
      for (let i = 0; i < source.geo.places.length; i += PLACE_STRIDE) {
        if (PLACE_CODES[source.geo.places[i + 2]!] !== 'worship') continue;
        const p = { x: source.geo.places[i]!, y: source.geo.places[i + 1]! };
        if (!this.owned(source, p)) continue;
        const at = this.world(source, p),
          id = worship.get(i / PLACE_STRIDE) ?? `worship/${at.x.toFixed(3)}/${at.y.toFixed(3)}`;
        if (!sites.has(`worship/${id}`))
          sites.set(`worship/${id}`, {
            id,
            kind: 'worship',
            at,
            radius: source.geo.places[i + 3]! / source.perMeter,
          });
      }
      for (const site of source.geo.hospitals ?? [])
        if (this.owned(source, site) && !sites.has(`hospital/${site.id}`))
          sites.set(`hospital/${site.id}`, {
            id: site.id,
            kind: 'hospital',
            at: this.world(source, site),
            radius: site.radius / source.perMeter,
          });
      for (const area of source.geo.fields ?? []) {
        const fragments = this.fields.get(area.id) ?? [];
        fragments.push({ source, rings: area.rings, kind: area.kind });
        this.fields.set(area.id, fragments);
      }
      for (const roof of source.geo.roofs ?? []) {
        const fragments = this.roofFragments.get(roof.id) ?? [];
        fragments.push({ source, rings: roof.rings });
        this.roofFragments.set(roof.id, fragments);
        if (this.owned(source, roof.anchor) && insidePolygon(roof.rings, roof.anchor)) {
          const at = this.world(source, roof.anchor),
            previous = roofs.get(roof.id);
          if (!previous || at.x < previous.at.x || (at.x === previous.at.x && at.y < previous.at.y))
            roofs.set(roof.id, { id: roof.id, at });
        }
      }
    }
    for (const [id, fragments] of cemeteries) {
      fragments.sort((a, b) => a.source.key.localeCompare(b.source.key));
      this.sites.push({
        id,
        kind: 'cemetery',
        at: this.interior(fragments[0]!, hashString(id))!,
        radius: 0,
        fragments,
      });
    }
    this.sites.push(...sites.values());
    this.sites.sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`));
    this.roofs.push(...[...roofs.values()].sort((a, b) => a.id.localeCompare(b.id)));
    // A spatial grid keeps roof neighborhoods and candidate admission bounded on dense city tiles.
    const buckets = new Map<string, RoofAnchor[]>(),
      size = FOLKLORE.roofRadius;
    const bucket = (p: Point) => `${Math.floor(p.x / size)}/${Math.floor(p.y / size)}`;
    for (const roof of this.roofs) {
      const values = buckets.get(bucket(roof.at)) ?? [];
      values.push(roof);
      buckets.set(bucket(roof.at), values);
    }
    const around = (p: Point, radius: number) => {
      const out: RoofAnchor[] = [];
      for (let x = Math.floor((p.x - radius) / size); x <= Math.floor((p.x + radius) / size); x++)
        for (let y = Math.floor((p.y - radius) / size); y <= Math.floor((p.y + radius) / size); y++)
          for (const roof of buckets.get(`${x}/${y}`) ?? [])
            if (distance(p, roof.at) <= radius) out.push(roof);
      return out;
    };
    const centres = new Set(
      this.roofs.filter((r) => around(r.at, size).length >= FOLKLORE.roofMinimum).map((r) => r.id),
    );
    for (const [id, fragments] of this.fields) {
      const anchors: { at: Point; kind: Candidate['kind'] }[] = [];
      for (const fragment of fragments) {
        const ring = fragment.rings[0] ?? [];
        for (let i = 0; i + 1 < ring.length; i++) {
          const p = mixPoint(ring[i]!, ring[i + 1]!, 0.5);
          if (this.owned(fragment.source, p))
            anchors.push({ at: this.world(fragment.source, p), kind: fragment.kind });
        }
      }
      anchors.sort(
        (a, b) =>
          hashString(`${id}/${a.at.x.toFixed(3)}/${a.at.y.toFixed(3)}`) -
            hashString(`${id}/${b.at.x.toFixed(3)}/${b.at.y.toFixed(3)}`) ||
          a.at.x - b.at.x ||
          a.at.y - b.at.y,
      );
      const anchor = anchors[0];
      if (!anchor) continue;
      const centre = around(anchor.at, FOLKLORE.fieldToCentre)
        .filter((r) => centres.has(r.id))
        .sort(
          (a, b) =>
            distance(anchor.at, a.at) - distance(anchor.at, b.at) || a.id.localeCompare(b.id),
        )[0];
      if (centre) this.candidates.push({ id, kind: anchor.kind, lower: anchor.at, centre });
    }
  }
  owned(source: FolkloreTile, p: Point) {
    return inTile(p) && source.owns(p);
  }
  world(source: Pick<FolkloreTile, 'tile'>, p: Point): Point {
    const f = frameBetween(source.tile, this.ref.tile);
    return {
      x: (f.x + p.x * f.scale) / this.ref.perMeter,
      y: (f.y + p.y * f.scale) / this.ref.perMeter,
    };
  }
  local(source: FolkloreTile, p: Point): Point {
    const f = frameBetween(this.ref.tile, source.tile);
    return {
      x: f.x + p.x * this.ref.perMeter * f.scale,
      y: f.y + p.y * this.ref.perMeter * f.scale,
    };
  }
  admitsRoof(id: string, p: Point) {
    return (
      this.roofFragments.get(id)?.some((f) => {
        const q = this.local(f.source, p);
        return this.owned(f.source, q) && insidePolygon(f.rings, q);
      }) ?? false
    );
  }
  admitsField(id: string, p: Point) {
    return (
      this.fields.get(id)?.some((f) => {
        const q = this.local(f.source, p);
        if (!this.owned(f.source, q)) return false;
        const ring = f.rings[0] ?? [];
        return ring.some(
          (a, i) =>
            distance(q, nearestOnSegment(q, a, ring[(i + 1) % ring.length]!).at) <=
            TILE_QUANTIZATION_TOLERANCE,
        );
      }) ?? false
    );
  }
  interior(fragment: Fragment, seed: number): Point | undefined {
    const { source, rings } = fragment,
      outer = rings[0];
    if (!outer?.length) return;
    const xs = outer.map((p) => p.x),
      ys = outer.map((p) => p.y),
      lowX = Math.max(0, Math.min(...xs)),
      highX = Math.min(EXTENT, Math.max(...xs)),
      lowY = Math.max(0, Math.min(...ys)),
      highY = Math.min(EXTENT, Math.max(...ys));
    const rng = random(seed ^ FOLKLORE.seed);
    for (let i = 0; i < 96; i++) {
      const p = { x: lowX + (highX - lowX) * rng(), y: lowY + (highY - lowY) * rng() };
      if (this.owned(source, p) && insidePolygon(rings, p)) return this.world(source, p);
    }
    const points = rings.flat(),
      holes: number[] = [];
    let offset = 0;
    for (let i = 0; i < rings.length; i++) {
      if (i) holes.push(offset);
      offset += rings[i]!.length;
    }
    const triangles = earcut(
      points.flatMap((p) => [p.x, p.y]),
      holes,
      2,
    );
    for (let i = 0; i < triangles.length; i += 3) {
      const a = points[triangles[i]!]!,
        b = points[triangles[i + 1]!]!,
        c = points[triangles[i + 2]!]!;
      const p = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
      if (this.owned(source, p) && insidePolygon(rings, p)) return this.world(source, p);
    }
  }
  cemeteryPath(fragment: Fragment, seed: number, travel: number) {
    const start = this.interior(fragment, seed);
    if (!start) return;
    const a = this.local(fragment.source, start),
      rng = random(seed ^ 0x37a6c9e1);
    for (let i = 0; i < 32; i++) {
      const angle = rng() * Math.PI * 2,
        reach = travel * fragment.source.perMeter;
      const b = { x: a.x + Math.cos(angle) * reach, y: a.y + Math.sin(angle) * reach };
      if (
        this.owned(fragment.source, b) &&
        segmentInside(fragment.rings, a, b) &&
        [0.25, 0.5, 0.75].every((t) => this.owned(fragment.source, mixPoint(a, b, t)))
      )
        return { start, end: this.world(fragment.source, b) };
    }
    return { start, end: start };
  }
  route(site: Site): Point[] {
    for (const walking of [true, false]) {
      const found: { distance: number; id: string; points: Point[] }[] = [];
      for (const source of this.sources)
        for (let line = 0; line < source.geo.kinds.length; line++) {
          const kind = source.geo.kinds[line]!;
          if (
            walking ? kind !== LifeLine.path && kind !== LifeLine.plaza : kind > LifeLine.roadMinor
          )
            continue;
          const points: Point[] = [];
          for (let v = source.geo.starts[line]!; v < source.geo.starts[line + 1]!; v++)
            points.push(
              this.world(source, {
                x: source.geo.coords[v * 2]!,
                y: source.geo.coords[v * 2 + 1]!,
              }),
            );
          for (let i = 0; i + 1 < points.length; i++) {
            const at = nearestOnSegment(site.at, points[i]!, points[i + 1]!).at;
            const d = distance(site.at, at);
            if (d <= 40 + site.radius && this.owned(source, this.local(source, at))) {
              // Start at the attachment and follow the longer connected half of this mapped line.
              const forward = [at, ...points.slice(i + 1)],
                back = [at, ...points.slice(0, i + 1).reverse()];
              const length = (p: Point[]) =>
                p.slice(1).reduce((s, b, j) => s + distance(p[j]!, b), 0);
              found.push({
                distance: d,
                id: `${source.geo.lineIds?.[line] ?? line}/${source.key}`,
                points: length(forward) >= length(back) ? forward : back,
              });
            }
          }
        }
      found.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
      if (found[0]) return found[0].points;
    }
    return [site.at];
  }
}

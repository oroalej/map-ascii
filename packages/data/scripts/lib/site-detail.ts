import {
  featureZoomBand,
  DetailSelectionSchema,
  tileZoomRange,
  type LngLat,
  type SiteDetail,
  type SubdivisionArea,
  isRoofBuilding,
} from '@atlas/shared';
import inside from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import type { Polygon, MultiPolygon, LineString, Position } from 'geojson';
import { TILE_ZOOMS, type AtlasFeature, type AtlasProperties } from '../03-normalize';
import { layerFor } from './classify';
import { bboxesOverlap, inBbox, localFrame as frame } from './geo';
import { seatingFootprint } from './footprints';
export { seatingFootprint } from './footprints';
import { isStandingBuilding, nearbyRoadFootprints } from './obstacles';
import { parkedVehicleParts } from './parked-vehicles';
import { geometryAudit } from './geometry-audit';

const distance = (a: Position, b: Position) => Math.hypot(...frame(a as LngLat).toMeters(b));

function feature(
  id: string,
  geometry: AtlasFeature['geometry'],
  properties: Partial<AtlasProperties>,
): AtlasFeature {
  const cls = properties.class ?? 'furniture';
  return {
    type: 'Feature',
    geometry,
    properties: { id, class: cls, ...properties },
    tippecanoe: {
      layer: layerFor(
        cls,
        geometry.type === 'Point' ? 'point' : geometry.type === 'LineString' ? 'line' : 'area',
      ),
      ...tileZoomRange(featureZoomBand(cls), TILE_ZOOMS),
    },
  };
}

const isArea = (g: AtlasFeature['geometry']): g is Polygon | MultiPolygon =>
  g.type === 'Polygon' || g.type === 'MultiPolygon';
const clip = (g: Polygon | MultiPolygon) =>
  (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) =>
    p.map((r) => r.map(([lng, lat]): LngLat => [lng!, lat!])),
  );
/** Check whole segments, including crossings of concave outlines and open interiors. */
function lineContained(line: LineString, area: Polygon | MultiPolygon): boolean {
  if (!line.coordinates.every((p) => inside(p, area))) return false;
  const rings = clip(area).flat();
  const cross = ([ax, ay]: LngLat, [bx, by]: LngLat) => ax * by - ay * bx;
  return line.coordinates.slice(1).every((b, i) => {
    const a = line.coordinates[i]!;
    const f = frame(a as LngLat);
    const end = f.toMeters(b);
    const cuts = [0, 1];
    for (const ring of rings)
      for (let j = 1; j < ring.length; j++) {
        const c = f.toMeters(ring[j - 1]!);
        const d = f.toMeters(ring[j]!);
        const edge: LngLat = [d[0] - c[0], d[1] - c[1]];
        const denominator = cross(end, edge);
        if (Math.abs(denominator) < 1e-12) continue;
        const t = cross(c, edge) / denominator;
        const u = cross(c, end) / denominator;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
      }
    cuts.sort((a, b) => a - b);
    return cuts.slice(1).every((t, j) => {
      const mid = (cuts[j]! + t) / 2;
      return inside(f.toLngLat([end[0] * mid, end[1] * mid]), area);
    });
  });
}

const contained = (
  g: AtlasFeature['geometry'],
  area: Polygon | MultiPolygon,
  audit: ReturnType<typeof geometryAudit>,
) =>
  g.type === 'Point'
    ? inside(g.coordinates, area)
    : g.type === 'LineString'
      ? lineContained(g, area)
      : isArea(g) && audit.contains(g);

/** OSM grounds can stop at a church's facade; allow a small boundary gap, not a remote alias. */
function selectionNear(
  g: AtlasFeature['geometry'],
  area: Polygon | MultiPolygon,
  audit: ReturnType<typeof geometryAudit>,
): boolean {
  if (contained(g, area, audit)) return true;
  if (!isArea(g)) return false;
  if (audit.overlaps(g, area)) return true;
  const rings = clip(area).flat();
  return clip(g)
    .flat()
    .some((ring) =>
      ring.some((point) => {
        const f = frame(point);
        return rings.some((boundary) =>
          boundary.slice(1).some((b, i) => {
            const [ax, ay] = f.toMeters(boundary[i]!);
            const [bx, by] = f.toMeters(b);
            const dx = bx - ax,
              dy = by - ay;
            const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
            return Math.hypot(ax + t * dx, ay + t * dy) <= 5;
          }),
        );
      }),
    );
}

/** Canonical metadata shared by authored grounds and disconnected cemetery rows. */
export function detailSelectionOf(p: AtlasProperties) {
  return DetailSelectionSchema.parse({
    id: p.id,
    class: p.class,
    ...(p.name !== undefined && { name: p.name }),
    ...(p.landmark_id !== undefined && { landmarkId: p.landmark_id }),
    ...(p.subdivision !== undefined && { subdivision: p.subdivision }),
    ...(p.subdivision_approx !== undefined && { subdivisionApprox: p.subdivision_approx }),
    ...(p.kind !== undefined && { kind: p.kind }),
    ...(p.height !== undefined &&
      p.height > 0 &&
      Number.isFinite(p.height) && { height: p.height }),
  });
}

/** Refresh aliased metadata once final classes, names and heights are known. */
export function finalizeDetailSelections(features: AtlasFeature[]): void {
  const byId = new Map<string, AtlasFeature>();
  for (const feature of features)
    if (!byId.has(feature.properties.id)) byId.set(feature.properties.id, feature);
  const selections = new Map<string, string>();
  for (const { properties } of features) {
    if (!properties.detail_selection || !properties.detail_parent) continue;
    let selection = selections.get(properties.detail_parent);
    if (!selection) {
      const parent = byId.get(properties.detail_parent);
      if (!parent)
        throw new Error(
          properties.id + ': missing canonical detail parent ' + properties.detail_parent,
        );
      selection = JSON.stringify(detailSelectionOf(parent.properties));
      selections.set(properties.detail_parent, selection);
    }
    properties.detail_selection = selection;
  }
}

function prepareDetailSites(input: AtlasFeature[], packs: readonly SiteDetail[]) {
  const features = input.map((f) => ({ ...f, properties: { ...f.properties } }));
  const byId = new Map<string, AtlasFeature>();
  for (const feature of features)
    if (!byId.has(feature.properties.id)) byId.set(feature.properties.id, feature);
  const audits = new Map<Polygon | MultiPolygon, ReturnType<typeof geometryAudit>>();
  const auditFor = (area: Polygon | MultiPolygon) => {
    let audit = audits.get(area);
    if (!audit) {
      audit = geometryAudit(area);
      audits.set(area, audit);
    }
    return audit;
  };
  const fits = (g: AtlasFeature['geometry'], area: Polygon | MultiPolygon) =>
    contained(g, area, auditFor(area));
  const standingTarget = (id: string) => {
    const target = byId.get(id);
    return target &&
      isRoofBuilding(target.properties.class) &&
      (target.properties.height ?? 0) > 0 &&
      isArea(target.geometry)
      ? { target, shape: target.geometry, height: target.properties.height! }
      : undefined;
  };
  const parents = new Set<string>();
  // Validate every anchor before mutation; overlap decisions must not depend on pack order.
  const sites = packs.map((pack) => {
    const parent = byId.get(pack.osm_id);
    if (
      !parent ||
      (!isArea(parent.geometry) &&
        !(pack.grounds && ['Point', 'LineString'].includes(parent.geometry.type)))
    )
      throw new Error(
        `${pack.id}: parent ${pack.osm_id} needs an existing OSM area or explicit grounds`,
      );
    if (parents.has(pack.osm_id))
      throw new Error(`${pack.id}: duplicate detail parent ${pack.osm_id}`);
    parents.add(pack.osm_id);
    if (parent.properties.height && !pack.grounds)
      throw new Error(`${pack.id}: a building parent needs curated grounds`);
    const area =
      pack.extent || pack.grounds
        ? { type: 'Polygon' as const, coordinates: [pack.extent ?? pack.grounds!] }
        : (parent.geometry as Polygon | MultiPolygon);
    if (pack.extent && (!isArea(parent.geometry) || !fits(area, parent.geometry)))
      throw new Error(`${pack.id}: extent must fit inside parent ${pack.osm_id}`);
    if (pack.grounds && !fits(parent.geometry, area))
      throw new Error(`${pack.id}: grounds must contain parent ${pack.osm_id}`);
    const selectionId = pack.selection_osm_id ?? pack.osm_id;
    const target = byId.get(selectionId);
    if (
      !target ||
      (pack.selection_osm_id &&
        (!target.properties.landmark_id || !selectionNear(target.geometry, area, auditFor(area))))
    )
      throw new Error(
        `${pack.id}: selection target must be an existing curated landmark inside or adjacent to the site`,
      );
    if (
      target.properties.detail_parent ||
      packs.some(
        (p) => p.osm_id === selectionId && p.selection_osm_id && p.selection_osm_id !== selectionId,
      )
    )
      throw new Error(`${pack.id}: selection targets cannot form alias chains`);
    const p = target.properties;
    const metadata =
      pack.surface === 'keep' || pack.grounds || pack.extent || pack.selection_osm_id
        ? JSON.stringify(detailSelectionOf(p))
        : undefined;
    return { pack, parent, area, selectionId, metadata };
  });
  for (let i = 0; i < sites.length; i++) {
    const a = sites[i]!;
    for (const b of sites.slice(i + 1))
      if (
        (a.pack.grounds || b.pack.grounds || a.pack.extent || b.pack.extent) &&
        auditFor(a.area).overlaps(a.area, b.area)
      )
        throw new Error(`${a.pack.id}: grounds overlap ${b.pack.id}`);
  }
  return { features, byId, auditFor, standingTarget, sites };
}

function applySiteOverrides({
  sites,
  standingTarget,
  auditFor,
}: ReturnType<typeof prepareDetailSites>) {
  const buildingTargets = new Set<string>();
  const roofTargets = new Set<string>();
  for (const { pack, area } of sites) {
    const audit = auditFor(area);
    for (const building of pack.building_overrides) {
      const standing = standingTarget(building.osm_id);
      if (buildingTargets.has(building.osm_id))
        throw new Error(`${pack.id}: duplicate building override ${building.osm_id}`);
      if (!standing || !audit.contains(standing.shape))
        throw new Error(
          `${pack.id}: building override ${building.osm_id} must be a standing building inside the site`,
        );
      buildingTargets.add(building.osm_id);
      standing.target.properties.height = building.height_m;
    }
    for (const roof of pack.roof_overrides) {
      const standing = standingTarget(roof.osm_id);
      if (roofTargets.has(roof.osm_id))
        throw new Error(`${pack.id}: duplicate roof override ${roof.osm_id}`);
      if (!standing || !audit.contains(standing.shape))
        throw new Error(
          `${pack.id}: roof override ${roof.osm_id} must be a standing building inside the site`,
        );
      roofTargets.add(roof.osm_id);
      standing.target.properties.variant = roof.shape;
    }
  }
}

function emitDetailStructures(
  { pack, area, metadata }: ReturnType<typeof prepareDetailSites>['sites'][number],
  input: AtlasFeature[],
  blocked: { feature: AtlasFeature; bounds: [number, number, number, number] }[],
  { auditFor, standingTarget }: ReturnType<typeof prepareDetailSites>,
  prefix: string,
  link: { detail_parent: string; detail_selection?: string },
  requireInside: (points: Position[], item: string) => void,
) {
  const audit = auditFor(area);
  const siteBounds = bbox(area) as [number, number, number, number];
  const roads =
    pack.parked_vehicles.length || pack.structures.some((part) => part.ground_override)
      ? nearbyRoadFootprints(input, siteBounds)
      : [];
  const seating = pack.seating.map((seat) => ({
    seat,
    shape: seatingFootprint(seat.line, seat.width_m, seat.bench_spans),
  }));
  const inventory = pack.parked_vehicles.map((vehicle) => ({
    vehicle,
    parts: parkedVehicleParts(vehicle),
  }));
  const vehicleParts = inventory.flatMap(({ parts }) => parts);
  const partShapes = new Map(
    [...pack.structures, ...vehicleParts].map(
      (part): [SiteDetail['structures'][number], Polygon] => [
        part,
        { type: 'Polygon', coordinates: [part.ring, ...(part.holes ?? [])] },
      ],
    ),
  );
  const shapeOf = (part: SiteDetail['structures'][number]) => partShapes.get(part)!;
  const vehicleIds = new Set(vehicleParts.map((part) => part.id));
  const vehicleKinds = new Map(
    inventory.flatMap(({ vehicle, parts }) =>
      parts.map((part) => [part.id, vehicle.kind] as const),
    ),
  );
  if (pack.structures.some((part) => vehicleIds.has(part.id)))
    throw new Error(`${pack.id}: duplicate parked vehicle structure id`);
  const vehicleFootprints = inventory.map(({ parts }) => audit.union(parts.map(shapeOf)));
  const vehicleBounds = vehicleFootprints.map(
    (shape) => bbox(shape) as [number, number, number, number],
  );
  const parkingObstacles = vehicleParts.length
    ? [
        ...roads.filter((road) =>
          vehicleBounds.some((bounds) => bboxesOverlap(bounds, road.bounds)),
        ),
        ...input
          .filter(
            (f) =>
              f.properties.class.startsWith('water') &&
              isArea(f.geometry) &&
              bboxesOverlap(siteBounds, bbox(f) as [number, number, number, number]),
          )
          .map((f) => ({ id: f.properties.id, geometry: f.geometry as Polygon | MultiPolygon })),
      ]
    : [];
  for (const part of vehicleParts) {
    for (const obstacle of parkingObstacles)
      if (audit.overlaps(shapeOf(part), obstacle.geometry))
        throw new Error(`${pack.id} structure ${part.id}: crosses ${obstacle.id}`);
    for (const roof of pack.structures.filter((part) => part.material === 'roof'))
      if (audit.overlaps(shapeOf(part), shapeOf(roof)))
        throw new Error(`${pack.id} structure ${part.id}: crosses reference roof ${roof.id}`);
  }
  for (const [i, footprint] of vehicleFootprints.entries()) {
    // A contained union proves all seven parts fit, including wheels and parent holes.
    if (!audit.contains(footprint)) {
      const part = inventory[i]!.parts.find((part) => !audit.contains(shapeOf(part)))!;
      throw new Error(`${pack.id} structure ${part.id}: outside parent footprint`);
    }
    if (vehicleFootprints.slice(0, i).some((other) => audit.overlaps(footprint, other)))
      throw new Error(`${pack.id}: overlapping parked vehicles`);
  }
  const structures = [...pack.structures, ...vehicleParts].map((part) => {
    const shape = shapeOf(part);
    const outer: Polygon = { type: 'Polygon', coordinates: [part.ring] };
    const holes = (part.holes ?? []).map((ring): Polygon => ({
      type: 'Polygon',
      coordinates: [ring],
    }));
    for (const [i, hole] of holes.entries()) {
      if (
        !auditFor(outer).contains(hole) ||
        holes.slice(0, i).some((other) => audit.overlaps(hole, other)) ||
        auditFor(hole).contains(outer)
      )
        throw new Error(`${pack.id} structure ${part.id}: invalid or overlapping interior`);
    }
    requireInside(part.ring, `structure ${part.id}`);
    // Vertices alone miss a footprint crossing a concavity or covering a parent hole.
    if (!vehicleIds.has(part.id) && !audit.contains(shape))
      throw new Error(`${pack.id} structure ${part.id}: outside parent footprint`);
    // Ground replacements must clear complete mapped carriageways in every city pack.
    if (part.ground_override)
      for (const road of roads.filter((road) => road.class !== 'path')) {
        if (audit.overlaps(shape, road.geometry))
          throw new Error(pack.id + ' structure ' + part.id + ': crosses ' + road.id);
      }
    if (part.roof_osm_id) {
      const roof = standingTarget(part.roof_osm_id);
      if (!roof || !auditFor(roof.shape).contains(shape) || part.height_m <= roof.height)
        throw new Error(
          `${pack.id} structure ${part.id}: roof wing must fit above ${part.roof_osm_id}`,
        );
    }
    // Opt-in ground replacements must not paint a court through a standing footprint.
    // Test polygon interiors, including obstacles wholly enclosed by the proposed court.
    if (
      vehicleIds.has(part.id) ||
      part.ground_override ||
      ['pitch', 'water'].includes(part.material)
    )
      for (const obstacle of blocked)
        if (audit.overlaps(shape, obstacle.feature.geometry as Polygon | MultiPolygon))
          throw new Error(
            `${pack.id} structure ${part.id}: crosses ${obstacle.feature.properties.id}`,
          );
    if (part.material === 'water')
      for (const water of input.filter(
        (f) => f.properties.class === 'water_area' && isArea(f.geometry),
      ))
        if (audit.overlaps(shape, water.geometry as Polygon | MultiPolygon))
          throw new Error(`${pack.id} structure ${part.id}: duplicates ${water.properties.id}`);
    return feature(`${prefix}/structure-${part.id}`, shape, {
      class: part.roof_shape
        ? // Roof surfaces have no independent school/market activity; selection uses link.
          'building'
        : part.material === 'water'
          ? 'water_area'
          : part.material === 'pitch'
            ? 'pitch'
            : part.material === 'paving'
              ? 'paving'
              : part.material === 'wood'
                ? 'building_woodwork'
                : 'building_part',
      height: part.height_m,
      ...(vehicleIds.has(part.id) && {
        kind: `parked_vehicle=${vehicleKinds.get(part.id)!}`,
      }),
      ...(part.material === 'water' && { kind: 'leisure=swimming_pool' }),
      variant:
        part.roof_shape ??
        (part.material === 'paving'
          ? part.ground_override
            ? 'terrace_override'
            : 'terrace'
          : 'flat'),
      detail_overhead: part.overhead,
      ...((part.material === 'paving' || metadata) && link),
      ...(!part.overhead &&
        !['paving', 'pitch'].includes(part.material) && { detail_blocked: true }),
    });
  });
  return { seating, structures };
}

/** Enrich a site's ground without replacing its buildings or canonical landmark identity. */
export function mergeSiteDetails(
  input: AtlasFeature[],
  packs: readonly SiteDetail[],
  subdivisions: readonly SubdivisionArea[] = [],
) {
  const context = prepareDetailSites(input, packs);
  const { features, byId, sites } = context;
  applySiteOverrides(context);
  const warnings: string[] = [];
  const relocated = new Set<string>();
  const blocked = input
    .filter(
      (f) =>
        !f.properties.detail_overhead &&
        isArea(f.geometry) &&
        (f.properties.detail_blocked ||
          f.properties.class === 'building_part' ||
          isStandingBuilding(f)),
    )
    .map((f) => ({ feature: f, bounds: bbox(f) as [number, number, number, number] }));
  for (const { pack, parent, area, selectionId, metadata } of sites) {
    const siteBounds = bbox(area) as [number, number, number, number];
    const nearbyBlocked = blocked.filter((obstacle) => bboxesOverlap(obstacle.bounds, siteBounds));
    const requireInside = (points: Position[], item: string) => {
      if (points.some((p) => !inside(p, area)))
        throw new Error(`${pack.id} ${item}: outside parent footprint`);
    };
    const prefix = `detail:${pack.id.slice(7)}`;
    const link = {
      detail_parent: selectionId,
      ...(metadata && { detail_selection: metadata }),
    };
    if (pack.surface === 'paving') {
      if (pack.grounds || pack.extent)
        features.push(feature(`${prefix}/grounds`, area, { class: 'paving', ...link }));
      else {
        parent.properties.class = 'paving';
        parent.tippecanoe = {
          layer: 'landuse',
          ...tileZoomRange(featureZoomBand('paving'), TILE_ZOOMS),
        };
      }
    }
    if (selectionId !== pack.osm_id) Object.assign(parent.properties, link);
    const { seating, structures } = emitDetailStructures(
      { pack, parent, area, selectionId, metadata },
      input,
      nearbyBlocked,
      context,
      prefix,
      link,
      requireInside,
    );
    features.push(...structures);
    const obstacles = [
      ...nearbyBlocked.map((f) => f.feature),
      ...seating.map(({ seat, shape }) =>
        feature(`${prefix}/seating-${seat.id}`, shape, { detail_blocked: true }),
      ),
      ...structures.filter((f) => f.properties.detail_blocked),
    ].map((feature) => ({ feature, bounds: bbox(feature) as [number, number, number, number] }));
    const requireClear = (points: Position[], item: string) => {
      requireInside(points, item);
      for (const { feature: obstacle, bounds } of obstacles)
        if (
          points.some(
            (p) =>
              inBbox(p[0]!, p[1]!, bounds) &&
              inside(p, obstacle.geometry as Polygon | MultiPolygon),
          )
        )
          throw new Error(`${pack.id} ${item}: crosses ${obstacle.properties.id}`);
    };
    for (const pole of pack.flagpoles) {
      if (relocated.has(pole.osm_id))
        throw new Error(`${pack.id}: duplicate flagpole target ${pole.osm_id}`);
      const target = byId.get(pole.osm_id);
      if (
        !target ||
        target.geometry.type !== 'Point' ||
        target.properties.class !== 'furniture' ||
        target.properties.variant !== 'flagpole'
      )
        throw new Error(`${pack.id}: ${pole.osm_id} must be an existing mapped flagpole point`);
      requireClear([pole.at], `flagpole ${pole.osm_id}`);
      relocated.add(pole.osm_id);
      target.geometry = { type: 'Point', coordinates: [...pole.at] };
      const properties = target.properties;
      if (pole.flag !== undefined) properties.flag = pole.flag;
      if (properties.label_lng !== undefined || properties.label_lat !== undefined) {
        [properties.label_lng, properties.label_lat] = pole.at;
      }
      // A correction can cross a subdivision boundary, including an approximate one.
      delete properties.subdivision;
      delete properties.subdivision_approx;
      const containing = subdivisions.filter((s) =>
        inside(pole.at, s.geometry as Polygon | MultiPolygon),
      );
      const subdivision = containing.find((s) => !s.approximate) ?? containing[0];
      if (subdivision) {
        properties.subdivision = subdivision.name;
        if (subdivision.approximate) properties.subdivision_approx = true;
      }
    }
    for (const walk of pack.walks) {
      // Sample the whole route, not just its vertices, against the parent and raised obstacles.
      const samples: LngLat[] = [];
      for (let i = 1; i < walk.line.length; i++) {
        const a = walk.line[i - 1]!,
          b = walk.line[i]!;
        const steps = Math.max(1, Math.ceil(distance(a, b) / 0.5));
        for (let j = 0; j <= steps; j++)
          samples.push([a[0] + ((b[0] - a[0]) * j) / steps, a[1] + ((b[1] - a[1]) * j) / steps]);
      }
      requireClear(samples, `walk ${walk.id}`);
      features.push(
        feature(
          `${prefix}/walk-${walk.id}`,
          { type: 'LineString', coordinates: walk.line },
          {
            class: 'path',
            width: walk.width_m,
            detail_route: true,
          },
        ),
      );
    }
    for (const { seat, shape } of seating) {
      requireInside(shape.coordinates.flat(2), `seating ${seat.id}`);
      features.push(
        feature(`${prefix}/seating-${seat.id}`, shape, {
          class: 'seating',
          height: seat.height_m,
          variant: 'seating',
          detail_blocked: true,
        }),
      );
      // Sparse pause anchors on the accessible side; bodies do not stand inside the stonework.
      const spans = seat.bench_spans ?? [
        { id: '', start: 0, end: seat.line.length - 1, width_m: seat.width_m },
      ];
      for (const span of spans) {
        let phase = 1.5;
        for (let i = span.start + 1; i <= span.end; i++) {
          const a = seat.line[i - 1]!,
            b = seat.line[i]!,
            f = frame(a);
          const [dx, dy] = f.toMeters(b),
            length = Math.hypot(dx, dy);
          const side = seat.facing === 'left' ? 1 : -1;
          const nx = (-dy / length) * side,
            ny = (dx / length) * side;
          for (; phase < length; phase += 4) {
            const at = f.toLngLat([
              (dx / length) * phase + nx * (span.width_m / 2 + 0.75),
              (dy / length) * phase + ny * (span.width_m / 2 + 0.75),
            ]);
            requireClear([at], `seating anchor ${seat.id}`);
            const mapped = input.some(
              (f) =>
                f.properties.class === 'furniture' &&
                f.properties.variant === 'bench' &&
                f.geometry.type === 'Point' &&
                distance(at, f.geometry.coordinates) <= 3,
            );
            if (mapped) {
              warnings.push(`${pack.id}: mapped bench replaces seating anchor ${seat.id}`);
              continue;
            }
            const key = `${span.id ? `${span.id}-` : ''}${i}-${Math.round(phase * 100)}`;
            features.push(
              feature(
                `${prefix}/bench-${seat.id}-${key}`,
                { type: 'Point', coordinates: at },
                {
                  variant: 'bench',
                  seat_bearing: ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360,
                },
              ),
            );
          }
          phase -= length;
        }
      }
    }
    for (const lamp of pack.lamps) {
      requireInside([lamp.at], `lamp ${lamp.id}`);
      const mapped = input.some(
        (f) =>
          f.properties.class === 'furniture' &&
          f.properties.variant === 'lamp' &&
          f.geometry.type === 'Point' &&
          distance(lamp.at, f.geometry.coordinates) <= 3,
      );
      if (mapped) {
        warnings.push(`${pack.id}: mapped lamp replaces ${lamp.id}`);
        continue;
      }
      features.push(
        feature(
          `${prefix}/lamp-${lamp.id}`,
          { type: 'Point', coordinates: lamp.at },
          {
            variant: 'lamp',
            lamp_bearing: lamp.bearing,
            lamp_reach: lamp.reach_m,
            lamp_heads: lamp.heads,
            lamp_style: lamp.style,
          },
        ),
      );
    }
  }
  finalizeDetailSelections(features);
  return { features, warnings };
}

export const detailCredits = (packs: readonly SiteDetail[]) => [
  ...new Set(packs.map((p) => p.credit)),
];

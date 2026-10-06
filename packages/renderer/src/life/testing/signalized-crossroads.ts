import { hashString, metersPerUnit, tileToLngLat } from '../../raster/geometry';
import { LifeBuilder, LifeLine } from '../geometry';
import { finalizeControlledCrossings, controlledCrossingConnectors } from '../crossing-geometry';
import { stripRing } from '../terrain';
import type { SignalLayout } from '@atlas/shared';
export function signalizedCrossroads(tile: { z: number; x: number; y: number }) {
  const b = new LifeBuilder(),
    pm = 1 / metersPerUnit(tile),
    center = { x: 2048, y: 2048 },
    members = [tileToLngLat(tile, center)],
    arms: SignalLayout['arms'] = [];
  const roads = [];
  for (const [index, [hx, hy]] of (
    [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ] as const
  ).entries()) {
    const end = { x: center.x + hx * 1800, y: center.y + hy * 1800 },
      road = `signalized-road:${index}`,
      group = index % 2 ? 'b' : 'a';
    b.line([center, end], LifeLine.roadMajor, 14, hashString(road));
    const quad = [stripRing(center, end, 7 * pm)];
    roads.push(quad);
    b.area('carriageway', quad);
    const cross = { x: center.x + hx * 10 * pm, y: center.y + hy * 10 * pm },
      side = { x: -hy, y: hx },
      bearing = ((Math.atan2(hx, -hy) * 180) / Math.PI + 360) % 180;
    const id = `controlled:${index}`,
      walk = group === 'a' ? 'b' : 'a';
    b.line(
      [
        { x: cross.x - side.x * 10 * pm, y: cross.y - side.y * 10 * pm },
        { x: cross.x + side.x * 10 * pm, y: cross.y + side.y * 10 * pm },
      ],
      LifeLine.path,
      3,
      hashString(id),
    );
    for (const direction of [-1, 1])
      b.line(
        [
          {
            x: center.x + side.x * 10 * direction * pm,
            y: center.y + side.y * 10 * direction * pm,
          },
          { x: end.x + side.x * 10 * direction * pm, y: end.y + side.y * 10 * direction * pm },
        ],
        LifeLine.path,
        2,
      );
    b.area('crossing', [
      stripRing(
        { x: cross.x - hx * 1.5 * pm, y: cross.y - hy * 1.5 * pm },
        { x: cross.x + hx * 1.5 * pm, y: cross.y + hy * 1.5 * pm },
        8.5 * pm,
      ),
    ]);
    b.controlledCrossing({
      id,
      anchor: cross,
      bearing,
      width: 14,
      lineId: hashString(id),
      controller: { id: 'crossroads-control', at: members[0]!, seed: 7, midBlock: false, walk },
    });
    const stop = {
        x: center.x + hx * 13 * pm + hy * 3.5 * pm,
        y: center.y + hy * 13 * pm - hx * 3.5 * pm,
      },
      inbound = ((Math.atan2(-hx, hy) * 180) / Math.PI + 360) % 360;
    arms.push({
      road_id: road,
      junction: members[0]!,
      toward: tileToLngLat(tile, end),
      direction: -1,
      inbound: true,
      outbound: true,
      bearing: inbound,
      width: 14,
      group,
      stop: tileToLngLat(tile, stop),
      stop_width: 7,
      stop_bearing: inbound,
    });
  }
  b.signal(center, 8, 90, 0, true, { members, arms }, { id: 'crossroads-control', seed: 7 });
  finalizeControlledCrossings(b.crossingAnchors, roads, pm);
  const routes = controlledCrossingConnectors(
    b.crossingAnchors,
    b.walkingLinesView,
    b.roadPolygons,
    b.crossingCuts,
    [],
    pm,
    hashString,
  );
  b.joinWalking(routes.joins, routes.connectors);
  return b.finish();
}

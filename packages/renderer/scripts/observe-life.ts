import type { LifeDiagnostics } from '../src/life/diagnostics';
import type { LifeWorld, TileLife, Mover } from '../src/life/simulate';
import type { Body, PolygonIndex } from '../src/life/occupancy';

export const MEASUREMENT_VERSION = 3;

/** Convert fresh diagnostic footprints into the world's reference tile frame. */
export function referenceBodies(bodies: Body[], origin: { x: number; y: number; scale: number }) {
  for (const b of bodies) {
    b.x = origin.x + b.x * origin.scale;
    b.y = origin.y + b.y * origin.scale;
    b.length *= origin.scale;
    b.width *= origin.scale;
  }
  return bodies;
}

/** Read-only classification, shared verbatim by immutable PRE and POST engines. */
export function classifyTerminalStops(world: LifeWorld, diagnostics: LifeDiagnostics) {
  const state = world as unknown as {
    tiles: Map<string, TileLife>;
    groundTerrain?: {
      blocked: PolygonIndex;
      origins: Map<TileLife, { x: number; y: number; scale: number }>;
    };
  };
  const terrain = state.groundTerrain;
  if (!terrain) return;
  for (const life of state.tiles.values()) {
    const origin = terrain.origins.get(life);
    if (!origin) continue;
    for (const m of life.movers) {
      if (
        !diagnostics.tracks(m) ||
        m.kind !== 'vehicle' ||
        !m.vehicle ||
        !life.geo.oneway?.[m.line] ||
        Math.abs(m.v ?? m.speed) > 1e-8 * life.perMeter
      )
        continue;
      const end = m.dir === 1 ? life.geo.starts[m.line + 1]! - 1 : life.geo.starts[m.line]!;
      const x = life.geo.coords[end * 2]!,
        y = life.geo.coords[end * 2 + 1]!;
      // Clipped endpoints and failed transfers to an existing tile are motion failures.
      if (x <= 1 || y <= 1 || x >= 4095 || y >= 4095) continue;
      // Inspect mapped arms independently of the engine helper: PRE misses
      // through-line interior entries, which remain classified as failures.
      let outgoing = false;
      for (let line = 0; line < life.geo.kinds.length && !outgoing; line++) {
        if (line === m.line || life.geo.kinds[line]! > 2) continue;
        const first = life.geo.starts[line]!,
          last = life.geo.starts[line + 1]! - 1;
        for (let v = first; v <= last; v++) {
          if (life.geo.coords[v * 2] !== x || life.geo.coords[v * 2 + 1] !== y) continue;
          const flow = life.geo.oneway?.[line];
          if ((v < last && (!flow || flow === 1)) || (v > first && (!flow || flow === -1))) {
            outgoing = true;
            break;
          }
        }
      }
      if (outgoing) continue;
      const room = (
        life as unknown as { oneWayEndRoom(m: Mover): number | undefined }
      ).oneWayEndRoom(m);
      if (room === undefined || room > 1e-8 * life.perMeter) continue;
      const bodies = referenceBodies(life.groundBodies(m), origin);
      if (!terrain.blocked.hits(bodies)) diagnostics.classifyTerminal(m);
    }
  }
}

import { EXTENT, MERCATOR_METERS } from '../raster/geometry';
import type { TileId } from '../tiles';
import { LifeLine, type LifeGeometry } from './geometry';
import type { Mover } from './simulate';
import { VEHICLES } from './vehicles';

type Junction = { x: number; y: number; radius: number; key: string; lines: Map<number, number> };
/** Unsignalized priority applies only at shared road vertices, never geometric bridges. */
export class YieldControl {
  readonly junctions: Junction[];
  private holds = new WeakMap<Mover, { key: string; seconds: number }>();
  constructor(
    tile: TileId,
    private geo: LifeGeometry,
    private perMeter: number,
    private along: Float64Array,
  ) {
    const vertices = new Map<string, Junction & { arms: number }>();
    const scale = MERCATOR_METERS / (EXTENT * 2 ** tile.z);
    for (let line = 0; line < geo.kinds.length; line++) {
      if (geo.kinds[line]! > LifeLine.roadMinor) continue;
      const first = geo.starts[line]!,
        last = geo.starts[line + 1]! - 1;
      for (let v = first; v <= last; v++) {
        const x = geo.coords[v * 2]!,
          y = geo.coords[v * 2 + 1]!,
          local = `${x}/${y}`;
        const j = vertices.get(local) ?? {
          x,
          y,
          radius: 0,
          key: `${Math.round((tile.x * EXTENT + x) * scale)}/${Math.round((tile.y * EXTENT + y) * scale)}`,
          lines: new Map(),
          arms: 0,
        };
        j.arms += v === first || v === last ? 1 : 2;
        j.radius = Math.max(j.radius, (geo.widths[line] || 6) / 2 + 1);
        j.lines.set(line, along[v]!);
        vertices.set(local, j);
      }
    }
    this.junctions = [...vertices.values()].filter(
      (j) =>
        j.arms >= 3 &&
        j.lines.size >= 2 &&
        !Array.from({ length: (geo.signals?.length ?? 0) / 6 }, (_, i) => i * 6).some(
          (i) =>
            Math.hypot(j.x - geo.signals![i]!, j.y - geo.signals![i + 1]!) <=
            (j.radius + geo.signals![i + 2]! + 2) * perMeter,
        ),
    );
  }
  /** All tiles run this before any movement, so iteration order cannot change priority. */
  markBusy(movers: readonly Mover[], busy: Map<string, number>, active: (m: Mover) => boolean) {
    for (const j of this.junctions)
      for (const m of movers) {
        if (m.kind !== 'vehicle' || !active(m) || !j.lines.has(m.line)) continue;
        const d = Math.hypot(j.x - m.x, j.y - m.y) / this.perMeter;
        if (d > j.radius + 15 || (d > j.radius && (j.x - m.x) * m.hx + (j.y - m.y) * m.hy <= 0))
          continue;
        const rank = this.geo.kinds[m.line]!;
        busy.set(j.key, Math.min(rank, busy.get(j.key) ?? Infinity));
      }
  }
  speed(m: Mover, dt: number, busy: ReadonlyMap<string, number>): number {
    let speed = m.speed,
      approach = false;
    for (const j of this.junctions) {
      const stop = j.lines.get(m.line);
      if (stop === undefined) continue;
      const ahead =
        m.dir * (stop - this.along[m.from]! - m.dir * m.d) -
        (j.radius + 1.5 + (m.vehicle ? VEHICLES[m.vehicle].length / 2 : 2)) * this.perMeter;
      if (ahead < -0.5 * this.perMeter || ahead > 20 * this.perMeter) continue;
      approach = true;
      let hold = this.holds.get(m);
      if (!hold || hold.key !== j.key) this.holds.set(m, (hold = { key: j.key, seconds: 0 }));
      if ((busy.get(j.key) ?? Infinity) >= this.geo.kinds[m.line]! || hold.seconds >= 8) continue;
      hold.seconds = Math.min(8, hold.seconds + dt);
      speed = Math.min(speed, Math.max(0, ahead) / dt);
    }
    if (!approach) this.holds.delete(m);
    return speed;
  }
}

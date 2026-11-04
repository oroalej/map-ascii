/**
 * The life layer's second texture: per cell, which part each of its six sextants shows, so one
 * cell can hold a roof and a window (SPEC.md §4 "Life layer"). RGB holds six 4-bit values in
 * `stampMaster`'s bit order (`row * 2 + col`, low nibble first): a 3-bit part and a shade bit. A
 * holds `PartsFlag`. The main life texel still says which glyph, class, paint and agent bits the
 * cell has, so with this layer absent every cell falls back to one color.
 *
 * Nothing here can change which agents are drawn. Sextants are decided while packing but written
 * only after every agent has been admitted (`PartsQueue.seal`): a rejected agent drops its entries
 * instead of restoring them, and a soft edge cell only ever lands in a cell no agent took.
 */
import { LIFE_AGENT_MASK } from './turn-signals';

export const PartsFlag = {
  /** The cell's color comes from its sextants. */
  valid: 128,
  /** Its taillight sextants show the brake lamp. */
  brake: 1,
  /** The ground beside the agent in this cell lies in shadow. */
  shadowUnder: 2,
} as const;

/** A sextant's value: its part, with this bit when it is on the shaded side. */
export const SHADE_NIBBLE = 8;

/** Six sextants' values as the layer's RGB bytes, in one number. */
export const withSextant = (rgb: number, sextant: number, value: number) =>
  rgb | ((value & 15) << (sextant * 4));
export const sextantOf = (rgb: number, sextant: number) => (rgb >>> (sextant * 4)) & 15;
/** A whole texel from its RGB and flags, as the layer stores it (little endian). */
export const partsTexel = (rgb: number, flags: number) => ((rgb & 0xffffff) | (flags << 24)) >>> 0;

/** The layer's CPU copy, and the rows of it that hold anything. */
export type LifePartsTarget = { texels: Uint8Array; first: number; end: number };
export const createLifeParts = (cells: number, rows: number): LifePartsTarget => ({
  texels: new Uint8Array(cells * 4),
  first: rows,
  end: 0,
});

const texelAt = (out: Uint8Array, at: number) =>
  (out[at]! | (out[at + 1]! << 8) | (out[at + 2]! << 16) | (out[at + 3]! << 24)) >>> 0;

const CORE_STRIDE = 3;
const SOFT_STRIDE = 4;
/** A shadow caster: center, a meter forward, a meter right, half length, half width, height. */
export const SHADOW_STRIDE = 9;

/** Sextants waiting for their agents to be admitted; one is reused for every frame. */
export class PartsQueue {
  private core = new Uint32Array(CORE_STRIDE * 256);
  private soft = new Uint32Array(SOFT_STRIDE * 256);
  shadows = new Float64Array(SHADOW_STRIDE * 64);
  coreCount = 0;
  softCount = 0;
  shadowCount = 0;

  reset() {
    this.coreCount = this.softCount = this.shadowCount = 0;
  }
  /** Forget everything queued since these counts: the agent wasn't admitted. */
  rollback(core: number, soft: number, shadows: number) {
    this.coreCount = core;
    this.softCount = soft;
    this.shadowCount = shadows;
  }
  /** Something standing, whose shadow falls once the agent that owns it is admitted. */
  addShadow(
    cx: number,
    cy: number,
    ax: number,
    ay: number,
    sx: number,
    sy: number,
    halfLength: number,
    halfWidth: number,
    height: number,
  ) {
    if ((this.shadowCount + 1) * SHADOW_STRIDE > this.shadows.length) {
      const grown = new Float64Array(this.shadows.length * 2);
      grown.set(this.shadows);
      this.shadows = grown;
    }
    const slot = this.shadowCount++ * SHADOW_STRIDE;
    const { shadows } = this;
    shadows[slot] = cx;
    shadows[slot + 1] = cy;
    shadows[slot + 2] = ax;
    shadows[slot + 3] = ay;
    shadows[slot + 4] = sx;
    shadows[slot + 5] = sy;
    shadows[slot + 6] = halfLength;
    shadows[slot + 7] = halfWidth;
    shadows[slot + 8] = height;
  }
  /** A cell the agent holds: its sextants apply while the cell still shows the queued texel. */
  addCore(at: number, parts: number) {
    if ((this.coreCount + 1) * CORE_STRIDE > this.core.length) {
      const grown = new Uint32Array(this.core.length * 2);
      grown.set(this.core);
      this.core = grown;
    }
    const slot = this.coreCount++ * CORE_STRIDE;
    this.core[slot] = at;
    this.core[slot + 1] = parts;
  }
  /** Note the final texels queued since `from`, once lamps and beacons are written over them. */
  settleCore(out: Uint8Array, from: number) {
    for (let i = from; i < this.coreCount; i++) {
      const slot = i * CORE_STRIDE;
      this.core[slot + 2] = texelAt(out, this.core[slot]!);
    }
  }
  /** An edge cell the agent only reaches with some sextants: it never holds or denies a cell. */
  addSoft(at: number, parts: number, texel: number, owner: number) {
    if ((this.softCount + 1) * SOFT_STRIDE > this.soft.length) {
      const grown = new Uint32Array(this.soft.length * 2);
      grown.set(this.soft);
      this.soft = grown;
    }
    const slot = this.softCount++ * SOFT_STRIDE;
    this.soft[slot] = at;
    this.soft[slot + 1] = parts;
    this.soft[slot + 2] = texel;
    this.soft[slot + 3] = owner;
  }
  /**
   * Write what survived: a core cell's sextants if no later agent replaced it, and each soft cell
   * into a cell with no agent, first come first served. `parts` is cleared and rewritten, and its
   * `first`/`end` name the rows it now uses.
   */
  seal(out: Uint8Array, owners: Uint32Array | undefined, cols: number, parts?: LifePartsTarget) {
    if (parts) {
      parts.texels.fill(0, parts.first * cols * 4, parts.end * cols * 4);
      parts.first = out.length / 4 / cols;
      parts.end = 0;
    }
    for (let i = 0; i < this.coreCount; i++) {
      const slot = i * CORE_STRIDE;
      const at = this.core[slot]!;
      if (parts && texelAt(out, at) === this.core[slot + 2]!)
        writeParts(parts, at, this.core[slot + 1]!, cols);
    }
    for (let i = 0; i < this.softCount; i++) {
      const slot = i * SOFT_STRIDE;
      const at = this.soft[slot]!;
      if ((out[at + 2]! & LIFE_AGENT_MASK) !== 0) continue;
      const texel = this.soft[slot + 2]!;
      out[at] = texel & 255;
      out[at + 1] = (texel >>> 8) & 255;
      out[at + 2] = (texel >>> 16) & 255;
      out[at + 3] = texel >>> 24;
      if (owners) owners[at / 4] = this.soft[slot + 3]!;
      if (parts) writeParts(parts, at, this.soft[slot + 1]!, cols);
    }
  }
}

/** One cell of the layer, widening the rows it uses. */
export function writeParts(parts: LifePartsTarget, at: number, value: number, cols: number) {
  parts.texels[at] = value & 255;
  parts.texels[at + 1] = (value >>> 8) & 255;
  parts.texels[at + 2] = (value >>> 16) & 255;
  parts.texels[at + 3] = value >>> 24;
  const row = Math.floor(at / 4 / cols);
  if (row < parts.first) parts.first = row;
  if (row >= parts.end) parts.end = row + 1;
}

import { classId } from '../classes';
import { CellBit, cellBits } from './config';
import { LIFE_AGENT_MASK } from './turn-signals';
import type { CellTargets } from '../gpu';
import { SUB, unpackGlyph } from '../glyphs/select';
import type { GridPlacement } from '../picking';
import { MAX_PENDING_READS, type Readback } from '../readback';
import type { VisibleAgent } from './simulate';

export type LifeSurfaceFrame = {
  targets: Pick<CellTargets, 'cols' | 'rows' | 'glyphFbo' | 'sub'>;
  grid: GridPlacement;
  dpr: number;
  geometry: string;
  owners: Uint32Array;
  life: Uint8Array;
  agents: readonly VisibleAgent[];
  labelsCover: (point: readonly [number, number]) => boolean;
};
type SurfaceReads = Pick<Readback, 'size' | 'request'>;
const SURFACE_READ_COUNT = 3;
/** One pick and one class query can arrive before the next poll. */
export const LIFE_READBACK_HEADROOM = 2;
export const canReadLifeSurface = (reads: SurfaceReads) =>
  reads.size + SURFACE_READ_COUNT + LIFE_READBACK_HEADROOM <= MAX_PENDING_READS;

/** Capture only scalar request evidence: raster arrays can be repacked before callbacks run. */
export function readLifeSurface(
  reads: SurfaceReads,
  attachment: number,
  targets: LifeSurfaceFrame['targets'],
  sample: { col: number; row: number; sx: number; sy: number; cls: number; flags: number },
  done: (visible: boolean | undefined) => void,
  retired?: () => void,
): boolean {
  if (!canReadLifeSurface(reads)) {
    retired?.();
    return false;
  }
  const bytes: (Uint8Array | undefined)[] = [];
  const settled = [false, false, false];
  let remaining = 3,
    issuing = true,
    rejected = false,
    published = false,
    released = false;
  const conclude = () => {
    if (issuing) return;
    if (rejected && !published) {
      published = true;
      done(undefined);
    }
    if (remaining === 0 && !released) {
      released = true;
      retired?.();
    }
  };
  const settle = (index: number, data?: Uint8Array) => {
    if (settled[index]) return;
    settled[index] = true;
    remaining--;
    if (data?.length) bytes[index] = data;
    else rejected = true;
    conclude();
  };
  const finish = (index: number) => (data: Uint8Array) => {
    settle(index, data);
    if (!rejected && !published && bytes[0] && bytes[1] && bytes[2]) {
      published = true;
      done(
        lifeVisibleOnSurface(
          sample.cls,
          sample.flags,
          unpackGlyph(bytes[0][0]!, bytes[0][1]!).cls,
          bytes[1][0]!,
          bytes[2][0]!,
        ),
      );
    }
  };
  reads.request(
    targets.glyphFbo,
    attachment,
    { x: sample.col, y: sample.row, width: 1, height: 1 },
    finish(0),
    () => settle(0),
  );
  const rect = {
    x: sample.col * SUB.cols + sample.sx,
    y: sample.row * SUB.rows + sample.sy,
    width: 1,
    height: 1,
  };
  reads.request(targets.sub.fbo, attachment, rect, finish(1), () => settle(1));
  reads.request(targets.sub.fbo, attachment + 1, rect, finish(2), () => settle(2));
  issuing = false;
  conclude();
  return true;
}

const permissions = cellBits();
const trunk = classId('tree');
export const LIFE_OCCLUDERS = [trunk, classId('tree_crown'), classId('trees')] as const;
const occluders = new Set<number>(LIFE_OCCLUDERS);

/** Shared CPU surface/subcell predicate matching glyph.ts. */
export function lifeVisibleOnSurface(
  lifeClass: number,
  flags: number,
  coarse: number,
  sampled: number,
  height: number,
): boolean {
  const bits = flags & LIFE_AGENT_MASK;
  if (!bits) return false;
  const nonBird = lifeClass !== classId('life_bird');
  const surface = nonBird && coarse !== trunk ? sampled : coarse;
  if (nonBird && occluders.has(surface)) return false;
  const allowed = permissions[surface] ?? 0;
  return (
    (allowed & bits) !== 0 ||
    (bits === CellBit.person && (allowed & CellBit.grounds) !== 0 && height === 0)
  );
}

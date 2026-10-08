import { pointerCell } from '../picking';
import { SUB, unpackGlyph } from '../glyphs/select';
import { folkloreHit } from '../folklore-pass';
import { agentAt, describeAgent } from './describe';
import { LIFE_AGENT_MASK } from './turn-signals';
import { readLifeSurface, type LifeSurfaceFrame } from './surface-visibility';
import type { Readback } from '../readback';
import type { FolkloreQuad } from '../folklore-pass';
import type { LifeTap } from './tap';

export type TapCaptureFrame = LifeSurfaceFrame & {
  generation: number;
  frame: number;
  folklore: readonly FolkloreQuad[];
};

/** Captures the displayed frame independently of mouse hover and inspection. */
export function captureTap(
  point: readonly [number, number],
  tap: Omit<LifeTap, 'id' | 'agent' | 'folklore'>,
  f: TapCaptureFrame,
  reads: Pick<Readback, 'size' | 'request'>,
  attachment: number,
  current: () => boolean,
  done: (tap: Omit<LifeTap, 'id'>) => void,
) {
  if (f.labelsCover(point)) return;
  const folklore = folkloreHit(f.folklore, point, f.dpr);
  if (folklore && folklore.kind !== 'lower-half') {
    if (current()) done({ ...tap, folklore: folklore.id });
    return;
  }
  const [col, row] = pointerCell(point, f.dpr, f.grid);
  const agent = agentAt(f.owners, f.targets.cols, f.targets.rows, f.agents, [col, row]);
  if (!agent || !describeAgent(agent)) {
    if (current()) done(tap);
    return;
  }
  const offset = (row * f.targets.cols + col) * 4;
  const sx = Math.min(
    SUB.cols - 1,
    Math.floor(((point[0] * f.dpr + f.grid.shiftX) / f.grid.cellWidth - col) * SUB.cols),
  );
  const sy = Math.min(
    SUB.rows - 1,
    Math.floor(((point[1] * f.dpr + f.grid.shiftY) / f.grid.cellHeight - row) * SUB.rows),
  );
  readLifeSurface(
    reads,
    attachment,
    f.targets,
    {
      col,
      row,
      sx,
      sy,
      cls: unpackGlyph(f.life[offset]!, f.life[offset + 1]!).cls,
      flags: f.life[offset + 2]! & LIFE_AGENT_MASK,
    },
    (visible) => {
      if (visible === undefined || !current()) return;
      done({ ...tap, ...(visible && { agent: f.agents.indexOf(agent) }) });
    },
  );
}

import { classId } from '../classes';
import type { CellTargets } from '../gpu';
import { SUB } from '../glyphs/select';
import { pointerCell, type GridPlacement } from '../picking';
import { MAX_PENDING_READS, type Readback } from '../readback';
import { CellBit, cellBits } from './config';
import { agentAt, describeAgent } from './describe';
import type { VisibleAgent } from './simulate';
import { LIFE_AGENT_MASK } from './turn-signals';

export type LifeHover = { label: string; point: [number, number] } | { label: null; point: null };
const permissions = cellBits();
const trunk = classId('tree');
const occluders = new Set([trunk, classId('tree_crown'), classId('trees')]);
const HOVER_VALIDITY_MS = 250;
const HOVER_RENEW_MS = HOVER_VALIDITY_MS / 2;

/** Mirrors the glyph pass: birds fly above surfaces; other agents use the pointed subcell. */
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

export type HoverFrame = {
  targets: Pick<CellTargets, 'cols' | 'rows' | 'glyphFbo' | 'sub'>;
  grid: GridPlacement;
  dpr: number;
  /** Changes with target generation, camera or grid placement, never with animation time. */
  geometry: string;
  revision: number;
  owners: Uint32Array;
  life: Uint8Array;
  agents: readonly VisibleAgent[];
  labelsCover: (point: readonly [number, number]) => boolean;
};

/** One bounded asynchronous visibility batch; no reads without a describable owner. */
export class LifeHoverController {
  private point: [number, number] | null = null;
  private frame: HoverFrame | null = null;
  private output: LifeHover = { label: null, point: null };
  private serial = 0;
  private pending: { serial: number; key: string; at: number } | undefined;
  private confirmed: { key: string; revision: number; visible: boolean; at: number } | undefined;
  private held: { agent: VisibleAgent; geometry: string; at: number } | undefined;
  private inspecting = false;

  constructor(
    private readonly readback: Pick<Readback, 'size' | 'request'>,
    private readonly attachment: number,
    private readonly emit: (hover: LifeHover) => void,
    private readonly inspect: (active: boolean) => void = () => {},
  ) {}

  pointer(point: [number, number] | null) {
    this.point = point ? [...point] : null;
    if (!point) this.clear();
  }

  clear() {
    this.serial++;
    this.pending = undefined;
    this.confirmed = undefined;
    this.frame = null;
    this.held = undefined;
    this.setInspection(false);
    this.publish(null);
  }

  private setInspection(active: boolean) {
    if (active === this.inspecting) return;
    this.inspecting = active;
    this.inspect(active);
  }

  private publish(label: string | null) {
    const point = label && this.point ? ([...this.point] as [number, number]) : null;
    if (
      label === this.output.label &&
      point?.[0] === this.output.point?.[0] &&
      point?.[1] === this.output.point?.[1]
    )
      return;
    this.output = label && point ? { label, point } : { label: null, point: null };
    this.emit(this.output);
  }

  private candidate() {
    const f = this.frame,
      p = this.point;
    if (!f || !p || f.labelsCover(p)) return null;
    const [col, row] = pointerCell(p, f.dpr, f.grid);
    const agent = agentAt(f.owners, f.targets.cols, f.targets.rows, f.agents, [col, row]);
    const label = agent && describeAgent(agent);
    if (!label) return null;
    const sx = Math.min(
      SUB.cols - 1,
      Math.floor(((p[0] * f.dpr + f.grid.shiftX) / f.grid.cellWidth - col) * SUB.cols),
    );
    const sy = Math.min(
      SUB.rows - 1,
      Math.floor(((p[1] * f.dpr + f.grid.shiftY) / f.grid.cellHeight - row) * SUB.rows),
    );
    const offset = (row * f.targets.cols + col) * 4;
    const lifeClass = f.life[offset + 1]! & 63;
    const lifeFlags = f.life[offset + 2]! & LIFE_AGENT_MASK;
    return {
      col,
      row,
      sx,
      sy,
      label,
      lifeClass,
      lifeFlags,
      agent,
      key: `${f.geometry}/${col}/${row}/${sx}/${sy}/${label}/${lifeClass}/${lifeFlags}`,
    };
  }

  update(frame: HoverFrame | null, now: number) {
    this.frame = frame;
    const c = this.candidate();
    if (!c || !frame) {
      this.clear();
      return;
    }
    if (
      this.pending &&
      (this.pending.key !== c.key || now - this.pending.at >= HOVER_VALIDITY_MS)
    ) {
      this.serial++;
      this.pending = undefined;
    }
    if (
      this.confirmed &&
      (this.confirmed.key !== c.key || now - this.confirmed.at >= HOVER_VALIDITY_MS)
    ) {
      this.confirmed = undefined;
    }
    if (this.confirmed?.key === c.key) {
      this.held = this.confirmed.visible
        ? { agent: c.agent, geometry: frame.geometry, at: this.confirmed.at }
        : undefined;
    }
    // Moving within a held figure can need a new subcell check. Keep the simulation still
    // while the old evidence is valid, without publishing an unverified tooltip there.
    const held = this.held;
    this.setInspection(
      !!held &&
        held.agent === c.agent &&
        held.geometry === frame.geometry &&
        now - held.at < HOVER_VALIDITY_MS,
    );
    if (this.confirmed?.key === c.key) this.publish(this.confirmed.visible ? c.label : null);
    else this.publish(null);
    if (this.pending) return;
    if (
      this.confirmed?.key === c.key &&
      this.confirmed.revision === frame.revision &&
      (!this.confirmed.visible || now - this.confirmed.at < HOVER_RENEW_MS)
    )
      return;
    if (this.readback.size > MAX_PENDING_READS - 3) return;
    const serial = ++this.serial;
    this.pending = { serial, key: c.key, at: now };
    const bytes: (Uint8Array | undefined)[] = [];
    const at = (index: number) => (data: Uint8Array) => {
      if (this.pending?.serial !== serial) return;
      bytes[index] = data;
      if (!bytes[0] || !bytes[1] || !bytes[2]) return;
      this.pending = undefined;
      if (this.candidate()?.key !== c.key) return;
      const visible = lifeVisibleOnSurface(
        c.lifeClass,
        c.lifeFlags,
        bytes[0][1]! & 63,
        bytes[1][0]!,
        bytes[2][0]!,
      );
      this.confirmed = { key: c.key, revision: frame.revision, visible, at: now };
      // Publish from update, once per animation frame, after all current geometry is known.
    };
    this.readback.request(
      frame.targets.glyphFbo,
      this.attachment,
      { x: c.col, y: c.row, width: 1, height: 1 },
      at(0),
    );
    const rect = { x: c.col * SUB.cols + c.sx, y: c.row * SUB.rows + c.sy, width: 1, height: 1 };
    this.readback.request(frame.targets.sub.fbo, this.attachment, rect, at(1));
    this.readback.request(frame.targets.sub.fbo, this.attachment + 1, rect, at(2));
  }
}

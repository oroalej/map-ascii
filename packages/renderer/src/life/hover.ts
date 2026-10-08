import { SUB, unpackGlyph } from '../glyphs/select';
import { pointerCell } from '../picking';
import type { Readback } from '../readback';
import { agentAt, describeAgent, describeFolklore } from './describe';
import { folkloreHit, type FolkloreQuad } from '../folklore-pass';
import type { VisibleAgent } from './simulate';
import { LIFE_AGENT_MASK } from './turn-signals';
import { canReadLifeSurface, readLifeSurface, type LifeSurfaceFrame } from './surface-visibility';

export type LifeHover = { label: string; point: [number, number] } | { label: null; point: null };
const HOVER_VALIDITY_MS = 250;
const HOVER_RENEW_MS = HOVER_VALIDITY_MS / 2;
const HOVER_MAX_VALIDITY_MS = 1000;
const HOVER_FRAME_INTERVAL_COUNT = 4;

export type HoverFrame = LifeSurfaceFrame & {
  folklore?: readonly FolkloreQuad[];
  generation?: number;
  revision: number;
};

/** One bounded asynchronous visibility batch; no reads without a describable owner. */
export class LifeHoverController {
  private point: [number, number] | null = null;
  private frame: HoverFrame | null = null;
  private output: LifeHover = { label: null, point: null };
  private serial = 0;
  private pending: { serial: number; key: string; at: number } | undefined;
  private confirmed: { key: string; revision: number; visible: boolean; at: number } | undefined;
  private held: { agent: VisibleAgent; identity: string; label: string; at: number } | undefined;
  private inspecting = false;
  private inspectedAgent: VisibleAgent | undefined;
  private lastUpdate: number | undefined;
  private intervals: number[] = [];

  constructor(
    private readonly readback: Pick<Readback, 'size' | 'request'>,
    private readonly attachment: number,
    private readonly emit: (hover: LifeHover) => void,
    private readonly inspect: (active: boolean) => void = () => {},
    private readonly inspectItem: (agent: VisibleAgent | null) => void = () => {},
  ) {}

  pointer(point: [number, number] | null) {
    this.point = point ? [...point] : null;
    if (!point) this.clear();
  }

  get hasPointer() {
    return this.point !== null;
  }

  get pointerPoint(): readonly [number, number] | null {
    return this.point;
  }

  clear() {
    this.lastUpdate = undefined;
    this.intervals.length = 0;
    this.serial++;
    this.pending = undefined;
    this.confirmed = undefined;
    this.frame = null;
    this.held = undefined;
    this.setInspection(false);
    this.publish(null);
  }

  private setInspection(active: boolean, agent?: VisibleAgent) {
    if (!active && this.inspectedAgent) {
      this.inspectedAgent = undefined;
      this.inspectItem(null);
    } else if (
      active &&
      agent &&
      (!this.inspectedAgent ||
        (agent.inspectionId !== undefined
          ? agent.inspectionId !== this.inspectedAgent.inspectionId
          : agent !== this.inspectedAgent))
    ) {
      this.inspectedAgent = agent;
      this.inspectItem(agent);
    }
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
    const lifeClass = unpackGlyph(f.life[offset]!, f.life[offset + 1]!).cls;
    const lifeFlags = f.life[offset + 2]! & LIFE_AGENT_MASK;
    const semantics = `${label}/${lifeClass}/${lifeFlags}`;
    const identity =
      `${f.generation ?? 0}/${agent.inspectionId ?? ''}/${f.geometry}` +
      (agent.inspectionId === undefined ? `/${semantics}` : '');
    return {
      col,
      row,
      sx,
      sy,
      label,
      lifeClass,
      lifeFlags,
      agent,
      identity,
      key: `${identity}/${semantics}/${col}/${row}/${sx}/${sy}`,
    };
  }

  update(frame: HoverFrame | null, now: number) {
    if (this.lastUpdate !== undefined && now > this.lastUpdate) {
      this.intervals.push(now - this.lastUpdate);
      if (this.intervals.length > HOVER_FRAME_INTERVAL_COUNT) this.intervals.shift();
    }
    this.lastUpdate = now;
    // Evidence is dated at request time: allow both the original two-frame read and
    // its two-frame renewal, but never keep a stalled result for more than a second.
    const validity = Math.min(
      HOVER_MAX_VALIDITY_MS,
      Math.max(HOVER_VALIDITY_MS, HOVER_FRAME_INTERVAL_COUNT * Math.max(0, ...this.intervals)),
    );
    this.frame = frame;
    const overlay =
      frame &&
      this.point &&
      !frame.labelsCover(this.point) &&
      folkloreHit(frame.folklore ?? [], this.point, frame.dpr);
    if (overlay) {
      this.serial++;
      this.pending = undefined;
      this.confirmed = undefined;
      this.held = undefined;
      this.setInspection(false);
      this.publish(describeFolklore(overlay));
      return;
    }
    const c = this.candidate();
    if (!c || !frame) {
      this.clear();
      return;
    }
    if (this.pending && (this.pending.key !== c.key || now - this.pending.at >= validity)) {
      this.serial++;
      this.pending = undefined;
    }
    if (this.confirmed && (this.confirmed.key !== c.key || now - this.confirmed.at >= validity)) {
      this.confirmed = undefined;
    }
    if (this.confirmed?.key === c.key) {
      this.held = this.confirmed.visible
        ? { agent: c.agent, identity: c.identity, label: c.label, at: this.confirmed.at }
        : undefined;
    }
    // Keep the existing item evidence while a new subcell is checked. Movement never
    // extends its lifetime; a negative result, identity change or expiry retracts it.
    const held = this.held;
    const holding =
      !!held &&
      (held.agent === c.agent ||
        (c.agent.inspectionId !== undefined && held.agent.inspectionId === c.agent.inspectionId)) &&
      held.identity === c.identity &&
      now - held.at < validity;
    this.setInspection(holding && !['bird', 'cat', 'dog'].includes(c.agent.kind), c.agent);
    if (this.confirmed?.key === c.key) this.publish(this.confirmed.visible ? c.label : null);
    else this.publish(holding ? held.label : null);
    if (this.pending) return;
    if (
      this.confirmed?.key === c.key &&
      (c.agent.inspectionId !== undefined || this.confirmed.revision === frame.revision) &&
      ((c.agent.inspectionId === undefined && !this.confirmed.visible) ||
        now - this.confirmed.at < HOVER_RENEW_MS)
    )
      return;
    if (!canReadLifeSurface(this.readback)) return;
    const serial = ++this.serial;
    const revision = frame.revision;
    this.pending = { serial, key: c.key, at: now };
    readLifeSurface(
      this.readback,
      this.attachment,
      frame.targets,
      {
        col: c.col,
        row: c.row,
        sx: c.sx,
        sy: c.sy,
        cls: c.lifeClass,
        flags: c.lifeFlags,
      },
      (visible) => {
        if (this.pending?.serial !== serial) return;
        this.pending = undefined;
        if (visible === undefined) return;
        this.confirmed = { key: c.key, revision, visible, at: now };
        // Publish from update, once per animation frame, after all current geometry is known.
      },
    );
  }
}

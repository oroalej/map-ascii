/** Admission adapter: the social controller never writes route cursors or meeting paths. */
import { inTile, PLACE_CODES, PLACE_STRIDE } from './geometry';
import { Moments, type MomentActor, type MomentAnchor, type MomentContext } from './moments';
import { FIGURE_SIZE_M, figureFit } from './people';
import type { Gatherer, LifeEnv, Mover, TileLife } from './simulate';

type Owner = (Mover | Gatherer) & { momentFacing?: { hx: number; hy: number } };
type Guard = (owner: Mover | Gatherer, before?: Mover | Gatherer) => boolean;
export type MomentOptions = { enabled?: boolean; rng?: () => number };
export class MomentHost {
  readonly moments: Moments;
  private readonly actors = new Map<object, MomentActor>();
  private readonly anchors: MomentAnchor[] = [];
  constructor(
    private readonly tile: TileLife,
    seed: number,
    options: MomentOptions = {},
  ) {
    this.moments = new Moments(seed, options.enabled ?? true, options.rng);
    const places = tile.geo.places;
    for (let i = 0; i < places.length; i += PLACE_STRIDE)
      if (
        PLACE_CODES[places[i + 2]!] === 'monument' &&
        inTile({ x: places[i]!, y: places[i + 1]! })
      )
        this.anchors.push({ x: places[i]!, y: places[i + 1]!, source: i / PLACE_STRIDE });
  }
  private refresh(near?: (x: number, y: number) => boolean) {
    const out: MomentActor[] = [];
    const update = (owner: Mover | Gatherer) => {
      if (near && !near(owner.x, owner.y)) return;
      const walker = 'kind' in owner ? owner.group?.[0] : owner.walker;
      if (!walker) return;
      let actor = this.actors.get(owner);
      if (!actor) {
        actor = {
          owner,
          type: 'kind' in owner ? 'walker' : 'gatherer',
          x: 0,
          y: 0,
          hx: 0,
          hy: 0,
          figure: walker.figure,
          idle: false,
        };
        this.actors.set(owner, actor);
      }
      const pose = 'kind' in owner ? this.tile.pose(owner) : owner;
      Object.assign(actor, {
        x: pose.x,
        y: pose.y,
        hx: owner.hx,
        hy: owner.hy,
        idle: owner.pause > 0,
        figure: walker.figure,
      });
      if (!('kind' in owner))
        Object.assign(actor, { place: owner.place, source: this.source(owner) });
      out.push(actor);
    };
    for (const m of this.tile.movers)
      if (m.kind === 'person' && m.group?.length === 1 && inTile(m)) update(m);
    for (const g of this.tile.gatherers)
      if (g.behavior !== 'sit' && g.behavior !== 'work' && inTile(g)) update(g);
    return out;
  }
  private source(owner: Gatherer): number | undefined {
    return (owner as Gatherer & { source?: number }).source;
  }
  clear() {
    this.moments.clear((actor) => {
      delete (actor.owner as Owner).momentFacing;
    });
    for (const owner of this.actors.keys()) delete (owner as Owner).momentFacing;
    this.actors.clear();
  }
  /** A pending release is retried by guarded movement, never an unguarded orientation snap. */
  release(owner: Owner, guard?: Guard) {
    if (!owner.momentFacing) return;
    const before = { ...owner };
    delete owner.momentFacing;
    if (!this.tile.canIdle(owner) || (guard && !guard(owner, before)))
      owner.momentFacing = before.momentFacing;
  }
  step(
    dt: number,
    zoom: number,
    env: LifeEnv | undefined,
    near: ((x: number, y: number) => boolean) | undefined,
    guard: Guard | undefined,
    cellWidth: number,
    cellAspect: number,
  ) {
    const { tile } = this;
    const eligible = (actor: MomentActor) => {
      const owner = actor.owner as Owner;
      if (!inTile(owner) || (near && !near(owner.x, owner.y))) return false;
      if ('kind' in owner) {
        if (
          owner.kind !== 'person' ||
          owner.group?.length !== 1 ||
          tile.scenes.visits.has(owner) ||
          (env?.levels && owner.rank >= env.levels.person)
        )
          return false;
      } else if (
        this.source(owner) === undefined ||
        (env?.levels && owner.rank >= env.levels.places[owner.place])
      )
        return false;
      return tile.canIdle(owner);
    };
    const c: MomentContext = {
      zoom,
      rain: env?.rain ?? 0,
      perMeter: tile.perMeter,
      anchors: this.anchors,
      actors: () => this.refresh(near),
      alive: (actor) =>
        'kind' in actor.owner
          ? tile.movers.includes(actor.owner as Mover)
          : tile.gatherers.includes(actor.owner as Gatherer),
      eligible,
      clearance: (actor) => {
        // Adults may have a canopy at any daylight setting: include it conservatively.
        const figure = actor.figure === 'adult' ? 'umbrella' : 'child';
        const width = Math.max(0, cellWidth),
          height = width * Math.max(1, cellAspect);
        const diagonal = Math.hypot(width, height);
        const size = FIGURE_SIZE_M[figure];
        const fit = figureFit(figure, width > 0 ? size / width : 0);
        // A one-cell glyph anywhere in the cell, a 2x2 figure, or a rotated square stamp
        // plus the boundary cells. Sum of radii guarantees distinct packed cell footprints.
        return (
          (fit === 'stamp'
            ? size / Math.SQRT2 + diagonal
            : fit === 'big'
              ? 2 * diagonal
              : diagonal) + 0.05
        );
      },
      face: (actor, hx, hy) => {
        const owner = actor.owner as Owner,
          before = { ...owner };
        owner.momentFacing = { hx, hy };
        if (!tile.canIdle(owner) || (guard && !guard(owner, before))) {
          if (before.momentFacing) owner.momentFacing = before.momentFacing;
          else delete owner.momentFacing;
          return false;
        }
        return true;
      },
      release: (actor) => this.release(actor.owner as Owner, guard),
    };
    this.moments.step(dt, c);
  }
  /** Paused monument visitors face the monument without enrolling in a timed hold. */
  attend(owner: Gatherer, guard?: Guard) {
    if (
      !this.moments.enabled ||
      owner.place !== 'monument' ||
      owner.pause <= 0 ||
      this.moments.busy(owner)
    )
      return;
    const d = Math.hypot(owner.cx - owner.x, owner.cy - owner.y);
    if (d <= 1e-9) return;
    const actor = owner as Owner,
      before = { ...actor };
    actor.momentFacing = { hx: (owner.cx - owner.x) / d, hy: (owner.cy - owner.y) / d };
    if (!this.tile.canIdle(actor) || (guard && !guard(actor, before))) {
      if (before.momentFacing) actor.momentFacing = before.momentFacing;
      else delete actor.momentFacing;
    }
  }
}

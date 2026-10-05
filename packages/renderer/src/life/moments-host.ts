import { gathererShare } from './gatherer-share';
/** Admission adapter: the social controller never writes route cursors or meeting paths. */
import { inTile, PLACE_CODES, PLACE_STRIDE, SITE_STRIDE, LifeLine } from './geometry';
import {
  MOMENTS,
  Moments,
  type MomentActor,
  type MomentAnchor,
  type MomentContext,
} from './moments';
import { FIGURE_SIZE_M, figureFit, type PersonPose } from './people';
import type { Gatherer, LifeEnv, Mover, Stall, TileLife } from './simulate';
import { LIFE_SITE_KINDS, type DialogueChoice, type GreetingPeriods } from '@atlas/shared';
import type { DialogueMemory } from './dialogue';
import { SceneSpeechHost } from './scene-speech-host';

type Owner = Mover | Gatherer;
type Guard = (owner: Mover | Gatherer, before?: Mover | Gatherer) => boolean;
export type MomentOptions = {
  enabled?: boolean;
  rng?: () => number;
  dialogue?: readonly DialogueChoice[];
  periods?: Readonly<GreetingPeriods>;
  memory?: DialogueMemory;
};
export class MomentHost {
  readonly moments: Moments<Owner>;
  private readonly sceneHost: SceneSpeechHost;
  get scenes() {
    return this.sceneHost.speech;
  }
  private inspected?: object;
  private heldPoses: (PersonPose | undefined)[] = [];
  /** Hold only the selected person's gesture; exchanges and other participants continue. */
  pose(owner: Owner | Stall, member = 0): PersonPose | undefined {
    if (owner === this.inspected) return this.heldPoses[member];
    return this.livePose(owner, member);
  }
  private livePose(owner: Owner | Stall, member: number): PersonPose | undefined {
    return this.moments.pose(owner) ?? this.scenes.pose(owner, member);
  }
  private actors = new WeakMap<Owner, MomentActor<Owner>>();
  private readonly candidates: MomentActor<Owner>[] = [];
  private readonly living = new Set<Owner>();
  private readonly poseScratch = { x: 0, y: 0, hx: 0, hy: 0 };
  private readonly anchors: MomentAnchor[] = [];
  private readonly sceneAnchors: MomentAnchor[] = [];
  private readonly stallAnchors = new WeakMap<Stall, MomentAnchor>();
  constructor(
    private readonly tile: TileLife,
    seed: number,
    options: MomentOptions = {},
  ) {
    this.sceneHost = new SceneSpeechHost(tile, seed, options);
    this.moments = new Moments<Owner>(
      seed,
      options.enabled ?? true,
      options.rng,
      options.dialogue,
      options.periods,
      options.memory,
    );
    const places = tile.geo.places;
    for (let i = 0; i < places.length; i += PLACE_STRIDE)
      if (
        ['monument', 'fountain', 'bench'].includes(PLACE_CODES[places[i + 2]!]!) &&
        inTile({ x: places[i]!, y: places[i + 1]! })
      )
        this.anchors.push({
          x: places[i]!,
          y: places[i + 1]!,
          source: i / PLACE_STRIDE,
          kind:
            PLACE_CODES[places[i + 2]!] === 'bench'
              ? 'seat'
              : (PLACE_CODES[places[i + 2]!] as 'monument' | 'fountain'),
        });
    const geo = tile.geo;
    for (let i = 0; i < geo.sites.length; i += SITE_STRIDE) {
      const kind = LIFE_SITE_KINDS[geo.sites[i + 2]!];
      if (
        (kind === 'stop' || kind === 'terminal') &&
        inTile({ x: geo.sites[i]!, y: geo.sites[i + 1]! })
      )
        this.anchors.push({ x: geo.sites[i]!, y: geo.sites[i + 1]!, source: -1 - i, kind: 'stop' });
    }
    for (let i = 0; i < geo.kinds.length; i++)
      if (geo.kinds[i] === LifeLine.plaza) {
        const at = geo.starts[i]! * 2;
        this.anchors.push({
          x: geo.coords[at]!,
          y: geo.coords[at + 1]!,
          source: -10000 - i,
          kind: 'plaza',
        });
      }
  }
  private refresh(near?: (x: number, y: number) => boolean) {
    const out = this.candidates;
    out.length = 0;
    const update = (owner: Mover | Gatherer) => {
      if (owner === this.inspected || (near && !near(owner.x, owner.y))) return;
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
      const pose = 'kind' in owner ? this.tile.pose(owner, this.poseScratch) : owner;
      actor.x = pose.x;
      actor.y = pose.y;
      actor.hx = owner.hx;
      actor.hy = owner.hy;
      actor.idle = owner.pause > 0;
      actor.figure = walker.figure;
      if (!('kind' in owner)) {
        actor.place = owner.place;
        actor.source = this.source(owner);
      }
      out.push(actor);
    };
    for (const m of this.tile.movers)
      if (m.kind === 'person' && m.group?.length === 1 && inTile(m)) update(m);
    for (const g of this.tile.gatherers)
      if (!g.seasonal && g.behavior !== 'sit' && g.behavior !== 'work' && inTile(g)) update(g);
    return out;
  }
  private source(owner: Gatherer): number | undefined {
    return owner.source;
  }
  clear() {
    this.inspected = undefined;
    this.heldPoses.length = 0;
    this.sceneHost.clear();
    this.moments.clear((actor) => {
      delete actor.owner.momentFacing;
    });
    for (const owner of this.tile.movers) delete owner.momentFacing;
    for (const owner of this.tile.gatherers) delete owner.momentFacing;
    this.actors = new WeakMap();
    this.candidates.length = 0;
    this.living.clear();
    this.sceneAnchors.length = 0;
  }
  /** A pending release is retried by guarded movement, never an unguarded orientation snap. */
  release(owner: Owner, guard?: Guard) {
    if (!owner.momentFacing) return;
    this.tryFacing(owner, undefined, guard);
  }
  private tryFacing(owner: Owner, next: Owner['momentFacing'], guard?: Guard) {
    if (owner === this.inspected) return false;
    const before = { ...owner };
    if (next) owner.momentFacing = next;
    else delete owner.momentFacing;
    if (!this.tile.canIdle(owner) || (guard && !guard(owner, before))) {
      if (before.momentFacing) owner.momentFacing = before.momentFacing;
      else delete owner.momentFacing;
      return false;
    }
    return true;
  }
  step(
    dt: number,
    zoom: number,
    env: LifeEnv | undefined,
    near: ((x: number, y: number) => boolean) | undefined,
    guard: Guard | undefined,
    cellWidth: number,
    cellAspect: number,
    inspected?: object,
  ) {
    if (inspected !== this.inspected) {
      this.heldPoses.length = 0;
      if (inspected) {
        const owner = inspected as Owner | Stall;
        const members = 'kind' in owner ? (owner.group?.length ?? 1) : 1;
        for (let member = 0; member < members; member++)
          this.heldPoses.push(this.livePose(owner, member));
      }
      this.inspected = inspected;
    }
    const { tile } = this;
    const anchors = this.sceneAnchors;
    anchors.length = 0;
    for (const anchor of this.anchors) anchors.push(anchor);
    for (let i = 0; i < tile.stalls.length; i++) {
      const stall = tile.stalls[i]!;
      if (stall.open === false) continue;
      let anchor = this.stallAnchors.get(stall);
      if (!anchor) {
        anchor = { x: stall.x, y: stall.y, source: -20000 - i, kind: 'stall' };
        this.stallAnchors.set(stall, anchor);
      }
      anchor.x = stall.x;
      anchor.y = stall.y;
      anchors.push(anchor);
    }
    const sceneChecks = this.sceneHost.step(dt, zoom, env, near, anchors);
    const eligible = (actor: MomentActor<Owner>) => {
      const owner = actor.owner;
      if (!inTile(owner) || (near && !near(owner.x, owner.y))) return false;
      if ('kind' in owner) {
        if (
          owner.kind !== 'person' ||
          owner.group?.length !== 1 ||
          this.scenes.busy(owner) ||
          tile.scenes.visits.has(owner) ||
          (env?.levels && owner.rank >= env.levels.person)
        )
          return false;
      } else if (
        owner.seasonal !== undefined ||
        this.source(owner) === undefined ||
        owner.rank >= gathererShare(owner, env?.levels)
      )
        return false;
      return tile.canIdle(owner);
    };
    const living = this.living;
    const c: MomentContext<Owner> = {
      zoom,
      rain: env?.rain ?? 0,
      minutes: env?.minutes,
      wind: env?.wind?.strength,
      clock: env?.clock,
      reserved: this.scenes.foregroundSize,
      sceneChecks,
      perMeter: tile.perMeter,
      anchors,
      actors: () => {
        living.clear();
        for (const owner of tile.movers) living.add(owner);
        for (const owner of tile.gatherers) living.add(owner);
        return this.refresh(near);
      },
      alive: (actor) => living.has(actor.owner),
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
      face: (actor, hx, hy) => this.tryFacing(actor.owner, { hx, hy }, guard),
      release: (actor) => this.release(actor.owner, guard),
    };
    this.moments.step(dt, c);
    this.scenes.reconcile(MOMENTS.capacity - this.moments.size, (owner) =>
      this.moments.busy(owner),
    );
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
    this.tryFacing(owner, { hx: (owner.cx - owner.x) / d, hy: (owner.cy - owner.y) / d }, guard);
  }
}

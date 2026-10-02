import type { VisibleAgent } from './simulate';

export type InspectionCommand = { id: number | null; revision: number; time: number };
export type InspectionAck = { id: number | null; revision: number };
type Actor = {
  owner: object;
  view?: VisibleAgent;
  seen: number;
  id: number;
  offset: number;
  effects: number;
  progressOffset: number;
  progress?: number;
  heldProgress?: number;
  bird?: VisibleAgent;
  birdAt?: number;
};

/** Production identities are independent of raster order and optional profiling identities. */
export class LifeInspection {
  private identities = new WeakMap<object, Actor>();
  private visible: Actor[] = [];
  private frame = 0;
  private next = 0;
  private selected: { owner: object; actor: Actor; at: number; effects: number } | undefined;
  private revision = 0;
  private time = 0;
  private effectTime = 0;
  private clockHistory = false;

  get ack(): InspectionAck {
    return { id: this.selected?.actor.id ?? null, revision: this.revision };
  }

  clear() {
    this.identities = new WeakMap();
    this.visible.length = 0;
    this.selected = undefined;
    // IDs never repeat in this world, including after a tile reset.
    this.revision = 0;
    this.clockHistory = false;
  }

  select(command: InspectionCommand, clock: number) {
    if (command.revision < this.revision) return;
    this.time = clock;
    this.effectTime = command.time;
    this.revision = command.revision;
    if (command.id === (this.selected?.actor.id ?? null)) return;
    this.release(clock);
    const actor =
      command.id === null ? undefined : this.visible.find((actor) => actor.id === command.id);
    if (!actor) return;
    const { owner, view } = actor;
    this.selected = { owner, actor, at: clock, effects: command.time };
    this.clockHistory = true;
    if (actor.progress !== undefined) actor.heldProgress = actor.progress - actor.progressOffset;
    if (view?.kind === 'bird') {
      actor.bird = { ...view, ahead: view.ahead && [...view.ahead] };
      actor.birdAt = clock;
    }
  }

  private release(clock: number) {
    if (!this.selected) return;
    const { actor, at, effects } = this.selected;
    actor.offset += Math.max(0, clock - at);
    actor.effects += Math.max(0, this.effectTime - effects);
    if (actor.heldProgress !== undefined) {
      actor.progressOffset = (actor.progress ?? actor.heldProgress) - actor.heldProgress;
      actor.heldProgress = undefined;
    }
    actor.birdAt = clock;
    this.selected = undefined;
  }

  /** Whether this identity is currently inspected. */
  held = (owner: object) => this.selected?.owner === owner;

  /** Direct identity comparisons keep movement and scene loops free of callback dispatch. */
  get owner() {
    return this.selected?.owner;
  }

  get active() {
    return this.selected !== undefined;
  }

  clock(owner: object, clock: number) {
    if (!this.clockHistory) return clock;
    const actor = this.identities.get(owner);
    return (this.held(owner) ? this.selected!.at : clock) - (actor?.offset ?? 0);
  }

  progress(owner: object, progress: number) {
    const actor = this.actor(owner);
    actor.progress = progress;
    if (actor.heldProgress !== undefined) {
      if (this.held(owner)) return actor.heldProgress;
      actor.progressOffset = progress - actor.heldProgress;
      actor.heldProgress = undefined;
    }
    return Math.max(0, progress - actor.progressOffset);
  }

  private actor(owner: object) {
    let actor = this.identities.get(owner);
    if (!actor) {
      actor = { owner, seen: -1, id: ++this.next, offset: 0, effects: 0, progressOffset: 0 };
      this.identities.set(owner, actor);
    }
    return actor;
  }

  begin(clock: number) {
    this.time = clock;
    this.frame++;
    this.visible.length = 0;
  }

  hasBird(owner: object) {
    return this.clockHistory && this.identities.get(owner)?.bird !== undefined;
  }

  /** Bird-only steering uses normal species speed, never fast-forwards a shared flock. */
  present(owner: object, view: VisibleAgent, birdSpeed?: number): VisibleAgent {
    const actor = this.actor(owner);
    const bird = actor.bird;
    if (bird && this.held(owner)) view = { ...bird };
    else if (bird && birdSpeed !== undefined) {
      const dt = Math.max(0, this.time - (actor.birdAt ?? this.time));
      actor.birdAt = this.time;
      const kx = 111_320 * Math.cos((bird.lat * Math.PI) / 180);
      const dx = (view.lng - bird.lng) * kx;
      const dy = (view.lat - bird.lat) * 110_540;
      const distance = Math.hypot(dx, dy);
      const reach = birdSpeed * dt;
      if (distance <= reach) actor.bird = undefined;
      else {
        const lng = bird.lng + ((dx / distance) * reach) / kx;
        const lat = bird.lat + ((dy / distance) * reach) / 110_540;
        view = {
          ...view,
          lng,
          lat,
          ahead: [lng + dx / distance / kx, lat + dy / distance / 110_540],
        };
        actor.bird = { ...view };
      }
    }
    view.inspectionId = actor.id;
    if (view.candle) view.candleSeed = actor.id & 31;
    if (view.candle && (this.held(owner) || actor.effects > 0))
      view.effectClock = this.held(owner)
        ? -(this.selected!.effects - actor.effects) - 2
        : actor.effects;
    // Only birds need a pose snapshot. Ground actors retain their own simulation
    // state; keeping their copied groups here adds avoidable GC roots/barriers.
    if (view.kind === 'bird') actor.view = view;
    else if (actor.view) actor.view = undefined;
    if (actor.seen !== this.frame) {
      actor.seen = this.frame;
      this.visible.push(actor);
    }
    return view;
  }

  finish(agents: VisibleAgent[], capped = false) {
    const kept = capped ? new Set(agents.map((agent) => agent.inspectionId)) : undefined;
    if (kept) this.visible = this.visible.filter((actor) => kept.has(actor.id));
    if (
      this.selected &&
      (this.selected.actor.seen !== this.frame || (kept && !kept.has(this.selected.actor.id)))
    )
      this.release(this.time);
    return agents;
  }
}

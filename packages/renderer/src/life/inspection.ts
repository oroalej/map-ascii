import type { VisibleAgent } from './simulate';
import { heldClock } from './effect-clocks';

export type InspectionCommand = { id: number | null; revision: number; time: number };
export type InspectionAck = { id: number | null; revision: number };
// Symbols stay on simulation objects: structured cloning does not send them to the main thread.
const INSPECTION_RECORD = Symbol('life inspection record');
type InspectionOwner = object & { [INSPECTION_RECORD]?: Actor };
type Actor = {
  registry: object;
  epoch: object;
  owner: object;
  view?: VisibleAgent;
  seen: number;
  kept: number;
  id: number;
  offset: number;
  effects: number;
  progressOffset: number;
  progress?: number;
  heldProgress?: number;
  bird?: VisibleAgent;
  birdAt?: number;
  birdClock?: boolean;
};

/** Production identities are independent of raster order and optional profiling identities. */
export class LifeInspection {
  private readonly registry = {};
  // A static slot keeps mover shapes stable across worlds. Only genuinely shared
  // owners use a weak fallback, leaving their first registry's slot intact.
  private sharedOwners?: WeakMap<object, Actor>;
  private epoch = {};
  private visible: Actor[] = [];
  private frame = 0;
  private next = 0;
  private selected: { owner: object; actor: Actor; at: number; effects: number } | undefined;
  private revision = 0;
  private time = 0;
  private effectTime = 0;
  private clockHistory = false;
  private birdSnapshots = 0;
  private birdClockOwners = 0;
  private capKeys?: Float64Array;
  private capStamps?: Uint32Array;
  private capStamp = 0;

  get ack(): InspectionAck {
    return { id: this.selected?.actor.id ?? null, revision: this.revision };
  }

  clear() {
    this.epoch = {};
    this.visible.length = 0;
    this.selected = undefined;
    // IDs never repeat in this world, including after a tile reset.
    this.revision = 0;
    this.clockHistory = false;
    this.birdSnapshots = 0;
    this.birdClockOwners = 0;
    this.sharedOwners = undefined;
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
      if (!actor.bird) this.birdSnapshots++;
      if (!actor.birdClock) {
        actor.birdClock = true;
        this.birdClockOwners++;
      }
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
    if (actor.birdClock && actor.offset === 0) {
      actor.birdClock = false;
      this.birdClockOwners--;
    }
  }

  /** Whether this identity is currently inspected. */
  held = (owner: object) => this.selected?.owner === owner;

  /** Direct identity comparisons keep movement and scene loops free of callback dispatch. */
  get owner() {
    return this.selected?.owner;
  }

  /** Bird gait offsets survive pose recovery for the owner's remaining lifetime. */
  get birds() {
    return this.birdClockOwners > 0;
  }

  get recoveringBirds() {
    return this.birdSnapshots > 0;
  }

  /** Only permanent retirement forgets a bird; frozen tiles may still revive it. */
  forgetBird(owner: object) {
    const actor = this.cached(owner);
    if (!actor) return;
    if (this.held(owner)) this.release(this.time);
    if (actor.bird) {
      actor.bird = undefined;
      this.birdSnapshots--;
    }
    if (actor.birdClock) {
      actor.birdClock = false;
      this.birdClockOwners--;
    }
  }

  private cached(owner: object) {
    const primary = (owner as InspectionOwner)[INSPECTION_RECORD];
    const actor = primary?.epoch === this.epoch ? primary : this.sharedOwners?.get(owner);
    return actor?.epoch === this.epoch ? actor : undefined;
  }

  clock(owner: object, clock: number) {
    if (!this.clockHistory) return clock;
    const actor = this.cached(owner);
    if (!actor) return clock;
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
    const cached = owner as InspectionOwner;
    const primary = cached[INSPECTION_RECORD];
    let actor = primary?.epoch === this.epoch ? primary : this.sharedOwners?.get(owner);
    if (actor?.epoch !== this.epoch) {
      actor = {
        registry: this.registry,
        epoch: this.epoch,
        owner,
        seen: -1,
        kept: -1,
        id: ++this.next,
        offset: 0,
        effects: 0,
        progressOffset: 0,
        birdClock: false,
      };
      if (primary && primary.registry !== this.registry) {
        this.sharedOwners ??= new WeakMap();
        this.sharedOwners.set(owner, actor);
      } else {
        Object.defineProperty(cached, INSPECTION_RECORD, {
          value: actor,
          writable: true,
          configurable: true,
        });
      }
    }
    return actor;
  }

  begin(clock: number) {
    this.time = clock;
    this.frame++;
    this.visible.length = 0;
  }

  hasBird(owner: object) {
    if (!this.recoveringBirds) return false;
    return this.cached(owner)?.bird !== undefined;
  }

  /** Bird-only steering uses normal species speed, never fast-forwards a shared flock. */
  present(owner: object, view: VisibleAgent, birdSpeed?: number): VisibleAgent {
    const actor = this.cached(owner) ?? this.actor(owner);
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
      if (distance <= reach) {
        actor.bird = undefined;
        this.birdSnapshots--;
      } else {
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
        ? heldClock(this.selected!.effects - actor.effects)
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
    if (capped) {
      const size = 2 ** Math.ceil(Math.log2(Math.max(2, agents.length * 2)));
      if (!this.capKeys || this.capKeys.length < size) {
        this.capKeys = new Float64Array(size);
        this.capStamps = new Uint32Array(size);
      }
      this.capStamp = (this.capStamp + 1) >>> 0;
      if (!this.capStamp) {
        this.capStamps!.fill(0);
        this.capStamp = 1;
      }
      const mask = this.capKeys.length - 1;
      for (const agent of agents) {
        const id = agent.inspectionId;
        if (id === undefined) continue;
        let slot = id & mask;
        while (this.capStamps![slot] === this.capStamp && this.capKeys[slot] !== id)
          slot = (slot + 1) & mask;
        this.capKeys[slot] = id;
        this.capStamps![slot] = this.capStamp;
      }
      let count = 0;
      for (const actor of this.visible) {
        let slot = actor.id & mask;
        while (this.capStamps![slot] === this.capStamp && this.capKeys[slot] !== actor.id)
          slot = (slot + 1) & mask;
        if (this.capStamps![slot] === this.capStamp) {
          actor.kept = this.frame;
          this.visible[count++] = actor;
        }
      }
      this.visible.length = count;
    }
    if (
      this.selected &&
      (this.selected.actor.seen !== this.frame ||
        (capped && this.selected.actor.kept !== this.frame))
    )
      this.release(this.time);
    return agents;
  }
}

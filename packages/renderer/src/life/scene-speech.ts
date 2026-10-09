/** Dialogue observes LocalScenes; it never changes a reservation, route or dwell time. */
import type { DialogueChoice, DialogueProfile, GreetingPeriods } from '@atlas/shared';
import { DialogueSelector, type DialogueContext, type DialogueMemory } from './dialogue';
import { MOMENTS, type SpeechCue } from './moments';
import type { PersonPose } from './people';

/** Leave room for physical encounters instead of filling every slot with passing groups. */
export const SCENE_SPEECH_CAPACITY = MOMENTS.scene.capacity;
export const AMBIENT_SPEECH_CAPACITY = MOMENTS.scene.ambientCapacity;
export type SceneSpeaker = { owner: object; member: number; figure: string };
export type SceneExchange = {
  kind?: DialogueChoice['kind'];
  requested?: boolean;
  key: object;
  speakers: readonly SceneSpeaker[];
  profiles: readonly DialogueProfile[];
  context: DialogueContext;
  valid(): boolean;
  /** Hard lifetime of the underlying service, never extended to finish a line. */
  remaining?: number;
  /** Background expression never reserves a person against physical or service activity. */
  ambient?: boolean;
  stationary?(): boolean;
};
type Active = {
  scene: SceneExchange;
  dialogue: DialogueChoice;
  start: number;
  turn: number;
  id: number;
  voiced: boolean;
};
export class SceneSpeech {
  readonly selector: DialogueSelector;
  private time = 0;
  private now = 0;
  private serial = 0;
  private readonly active: Active[] = [];
  private readonly owners = new Map<object, Active>();
  private seen = new WeakSet<object>();
  private readonly heard = new WeakSet<object>();
  private readonly completions: { token: object; owners: readonly object[] }[] = [];
  get voiceCompletions() {
    return this.completions as readonly { token: object; owners: readonly object[] }[];
  }
  voiceActive(owner: object) {
    const a = this.owners.get(owner);
    return !!a?.voiced && this.time >= a.start;
  }
  constructor(
    seed: number,
    choices: readonly DialogueChoice[],
    periods?: Readonly<GreetingPeriods>,
    memory?: DialogueMemory,
  ) {
    this.selector = new DialogueSelector(seed ^ 0x287c123, choices, periods, memory);
  }
  get size() {
    return this.active.length;
  }
  busy(owner: object) {
    const active = this.owners.get(owner);
    return !!active && !active.scene.ambient;
  }
  get foregroundSize() {
    return this.active.reduce((count, a) => count + Number(!a.scene.ambient), 0);
  }
  private remove(index: number, completed = false) {
    const [a] = this.active.splice(index, 1);
    if (completed && this.heard.has(a!))
      this.completions.push({ token: a!, owners: a!.scene.speakers.map((s) => s.owner) });
    for (const { owner } of a!.scene.speakers)
      if (this.owners.get(owner) === a) this.owners.delete(owner);
  }
  /** Newly admitted physical encounters take priority over background expressions. */
  reconcile(freeCapacity: number, busy: (owner: object) => boolean) {
    for (let i = this.active.length - 1; i >= 0; i--)
      if (
        this.active[i]!.scene.ambient &&
        this.active[i]!.scene.speakers.some((s) => busy(s.owner))
      )
        this.remove(i);
    while (this.active.length > freeCapacity) {
      const oldest = this.active.findIndex((a) => a.scene.ambient);
      if (oldest < 0) break;
      this.remove(oldest);
    }
  }
  step(dt: number, allowed: boolean, clock?: number) {
    this.completions.length = 0;
    for (const a of this.active) if (a.voiced && this.time >= a.start) this.heard.add(a);
    this.time += dt;
    this.now = clock ?? this.time;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i]!;
      const valid = allowed && a.scene.valid();
      const ended = this.time >= a.start + a.dialogue.turns * a.turn;
      if (!valid || ended) this.remove(i, valid && ended);
    }
  }
  admit(scene: SceneExchange, freeCapacity: number) {
    if (this.seen.has(scene.key) || !scene.valid()) return false;
    if (!scene.ambient && !scene.requested) {
      // Services replace background expressions; neither admission nor cancellation moves anyone.
      for (let i = this.active.length - 1; i >= 0; i--)
        if (
          this.active[i]!.scene.ambient &&
          this.active[i]!.scene.speakers.some((s) =>
            scene.speakers.some((other) => other.owner === s.owner),
          )
        )
          this.remove(i);
    }
    const owners = scene.speakers.map((s) => s.owner);
    const capacity = Math.min(freeCapacity, SCENE_SPEECH_CAPACITY);
    const spare =
      !scene.ambient && capacity > 0 && this.active.length >= capacity
        ? this.active.findIndex((a) => a.scene.ambient)
        : -1;
    if (
      (this.active.length >= capacity && (spare < 0 || this.active.length - 1 >= capacity)) ||
      (scene.ambient &&
        this.active.filter((a) => a.scene.ambient).length >= AMBIENT_SPEECH_CAPACITY) ||
      (!scene.requested &&
        !(scene.ambient
          ? this.selector.memory.ambientReady(owners, this.now)
          : this.selector.memory.ready(owners, this.now))) ||
      scene.speakers.some((s) => this.owners.has(s.owner))
    )
      return false;
    this.seen.add(scene.key);
    const context = {
      ...scene.context,
      figures: scene.speakers.map((s) => s.figure),
      profiles: scene.profiles,
    };
    const dialogue = scene.requested
      ? this.selector.request(scene.kind ?? 'talk', context)
      : this.selector.choose(scene.kind ?? 'talk', context, owners, false);
    if (!dialogue) return false;
    const vendor = dialogue.profile?.startsWith('vendor-');
    const turn = vendor ? MOMENTS.scene.vendorTurn : MOMENTS.scene.turn;
    if (scene.remaining !== undefined && scene.remaining + 1e-9 < turn * dialogue.turns)
      return false;
    // An unrelated expression yields only once the service can actually speak.
    if (spare >= 0) this.remove(spare);
    this.selector.admit(
      dialogue,
      scene.speakers.map((s) => s.owner),
    );
    // A farewell belongs at the end of the existing purchase, without prolonging it.
    const delay =
      dialogue.profile === 'vendor-thanks' && scene.remaining !== undefined
        ? Math.max(0, scene.remaining - turn * dialogue.turns)
        : 0;
    const active: Active = {
      scene,
      dialogue,
      start: this.time + delay,
      turn,
      id: ++this.serial,
      voiced: scene.requested || this.selector.memory.voiced(dialogue),
    };
    this.active.push(active);
    for (const owner of owners) this.owners.set(owner, active);
    const until = this.now + delay + turn * dialogue.turns + MOMENTS.cooldown;
    if (scene.ambient) this.selector.memory.reserveAmbient(owners, until);
    else this.selector.memory.reserve(owners, until);
    return true;
  }
  private current(owner: object) {
    const a = this.owners.get(owner);
    if (a) {
      const line = Math.floor((this.time - a.start) / a.turn + 1e-9);
      if (line < 0) return;
      const speaker = a.scene.speakers[a.dialogue.speakers?.[line] ?? line];
      if (line < a.dialogue.turns && speaker?.owner === owner) return { a, line, speaker };
    }
  }
  speech(owner: object): SpeechCue | undefined {
    const current = this.current(owner);
    if (!current?.a.voiced) return;
    const { a, line, speaker } = current;
    return {
      id: `scene:${a.id}:${a.start}`,
      exchangeId: a.dialogue.id,
      line,
      member: speaker.member,
    };
  }
  pose(owner: object, member: number): PersonPose | undefined {
    const current = this.current(owner);
    if (!current || current.speaker.member !== member || current.a.scene.stationary?.() === false)
      return;
    const phase = (this.time - current.a.start) % current.a.turn;
    return current.a.dialogue.delivery === 'utterance' && phase >= MOMENTS.gesture
      ? 'attentive'
      : 'gesture';
  }
  clear() {
    this.completions.length = 0;
    this.active.length = 0;
    this.owners.clear();
    this.seen = new WeakSet();
    this.selector.clear();
  }
}

/** Dialogue observes LocalScenes; it never changes a reservation, route or dwell time. */
import type { DialogueChoice, DialogueProfile, GreetingPeriods } from '@atlas/shared';
import { DialogueSelector, type DialogueContext, type DialogueMemory } from './dialogue';
import { MOMENTS, type SpeechCue } from './moments';
import type { PersonPose } from './people';

/** Leave room for physical encounters instead of filling every slot with passing groups. */
export const SCENE_SPEECH_CAPACITY = 4;
export const AMBIENT_SPEECH_CAPACITY = 2;
export type SceneSpeaker = { owner: object; member: number; figure: string };
export type SceneExchange = {
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
  private seen = new WeakSet<object>();
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
    return this.active.some(
      (a) => !a.scene.ambient && a.scene.speakers.some((s) => s.owner === owner),
    );
  }
  step(dt: number, allowed: boolean, clock?: number) {
    this.time += dt;
    this.now = clock ?? this.time;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i]!;
      if (!allowed || !a.scene.valid() || this.time >= a.start + a.dialogue.turns * a.turn)
        this.active.splice(i, 1);
    }
  }
  admit(scene: SceneExchange, freeCapacity: number) {
    if (this.seen.has(scene.key) || !scene.valid()) return false;
    if (!scene.ambient) {
      // Services replace background expressions; neither admission nor cancellation moves anyone.
      for (let i = this.active.length - 1; i >= 0; i--)
        if (
          this.active[i]!.scene.ambient &&
          this.active[i]!.scene.speakers.some((s) =>
            scene.speakers.some((other) => other.owner === s.owner),
          )
        )
          this.active.splice(i, 1);
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
      !this.selector.memory.ready(owners, this.now) ||
      scene.speakers.some((s) =>
        this.active.some((a) => a.scene.speakers.some((other) => other.owner === s.owner)),
      )
    )
      return false;
    this.seen.add(scene.key);
    const dialogue = this.selector.choose(
      'talk',
      { ...scene.context, figures: scene.speakers.map((s) => s.figure), profiles: scene.profiles },
      scene.speakers.map((s) => s.owner),
      false,
    );
    if (!dialogue) return false;
    const vendor = dialogue.profile?.startsWith('vendor-');
    const turn = vendor ? 1.5 : 3;
    if (scene.remaining !== undefined && scene.remaining + 1e-9 < turn * dialogue.turns)
      return false;
    // An unrelated expression yields only once the service can actually speak.
    if (spare >= 0) this.active.splice(spare, 1);
    this.selector.admit(
      dialogue,
      scene.speakers.map((s) => s.owner),
    );
    // A farewell belongs at the end of the existing purchase, without prolonging it.
    const delay =
      dialogue.profile === 'vendor-thanks' && scene.remaining !== undefined
        ? Math.max(0, scene.remaining - turn * dialogue.turns)
        : 0;
    this.active.push({
      scene,
      dialogue,
      start: this.time + delay,
      turn,
      id: ++this.serial,
      voiced: this.selector.memory.voiced(dialogue),
    });
    this.selector.memory.reserve(
      owners,
      this.now + delay + turn * dialogue.turns + MOMENTS.cooldown,
    );
    return true;
  }
  private current(owner: object) {
    for (const a of this.active) {
      if (!a.scene.valid()) continue;
      const line = Math.floor((this.time - a.start) / a.turn + 1e-9);
      if (line < 0) continue;
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
    this.active.length = 0;
    this.seen = new WeakSet();
    this.selector.clear();
  }
}

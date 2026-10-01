/** Dialogue observes LocalScenes; it never changes a reservation, route or dwell time. */
import type { DialogueChoice, DialogueProfile, GreetingPeriods } from '@atlas/shared';
import { DialogueSelector, type DialogueContext, type DialogueMemory } from './dialogue';
import { MOMENTS, type SpeechCue } from './moments';
import type { PersonPose } from './people';

/** Leave room for physical encounters instead of filling every slot with passing groups. */
export const SCENE_SPEECH_CAPACITY = 4;
export type SceneSpeaker = { owner: object; member: number; figure: string };
export type SceneExchange = {
  key: object;
  speakers: readonly SceneSpeaker[];
  profiles: readonly DialogueProfile[];
  context: DialogueContext;
  valid(): boolean;
  /** Hard lifetime of the underlying service, never extended to finish a line. */
  remaining?: number;
};
type Active = {
  scene: SceneExchange;
  dialogue: DialogueChoice;
  start: number;
  turn: number;
  id: number;
};
export class SceneSpeech {
  readonly selector: DialogueSelector;
  private time = 0;
  private serial = 0;
  private readonly active: Active[] = [];
  private seen = new WeakSet<object>();
  private cooldown = new WeakMap<object, number>();
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
    return this.active.some((a) => a.scene.speakers.some((s) => s.owner === owner));
  }
  step(dt: number, allowed: boolean) {
    this.time += dt;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i]!;
      if (!allowed || !a.scene.valid() || this.time >= a.start + a.dialogue.turns * a.turn)
        this.active.splice(i, 1);
    }
  }
  admit(scene: SceneExchange, freeCapacity: number) {
    if (
      Math.min(freeCapacity, SCENE_SPEECH_CAPACITY) <= this.active.length ||
      this.seen.has(scene.key) ||
      !scene.valid() ||
      scene.speakers.some(
        (s) => this.busy(s.owner) || (this.cooldown.get(s.owner) ?? 0) > this.time,
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
    this.selector.admit(
      dialogue,
      scene.speakers.map((s) => s.owner),
    );
    // A farewell belongs at the end of the existing purchase, without prolonging it.
    const delay =
      dialogue.profile === 'vendor-thanks' && scene.remaining !== undefined
        ? Math.max(0, scene.remaining - turn * dialogue.turns)
        : 0;
    this.active.push({ scene, dialogue, start: this.time + delay, turn, id: ++this.serial });
    for (const s of scene.speakers) this.cooldown.set(s.owner, this.time + MOMENTS.cooldown);
    return true;
  }
  speech(owner: object): SpeechCue | undefined {
    for (const a of this.active) {
      if (!a.scene.valid()) continue;
      const line = Math.floor((this.time - a.start) / a.turn + 1e-9);
      if (line < 0) continue;
      const speaker = a.scene.speakers[a.dialogue.speakers?.[line] ?? line];
      if (line < a.dialogue.turns && speaker?.owner === owner)
        return {
          id: `scene:${a.id}:${a.start}`,
          exchangeId: a.dialogue.id,
          line,
          member: speaker.member,
        };
    }
  }
  pose(owner: object, member: number): PersonPose | undefined {
    const cue = this.speech(owner);
    return cue?.member === member ? 'gesture' : undefined;
  }
  clear() {
    this.active.length = 0;
    this.seen = new WeakSet();
    this.cooldown = new WeakMap();
    this.selector.clear();
  }
}

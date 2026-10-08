/** Tap-only presentation for regenerated event actors; no physical actors are created. */
import type { DialogueProfile, EmojiMood } from '@atlas/shared';
import { EmojiMemory, EmojiObserver } from './emoji';
import { SceneSpeech } from './scene-speech';
import { MOMENTS } from './moments';
import type { MomentOptions } from './moments-host';
import type { LifeEnv, VisibleAgent } from './simulate';
import { TapReactions, type TapTarget } from './tap';

export class EventTaps {
  private readonly speech: SceneSpeech;
  private readonly emoji: EmojiObserver;
  private readonly reactions = new TapReactions();
  private readonly owners = new Map<object, number>();
  private readonly greeted = new WeakMap<object, number>();
  constructor(
    readonly scope: string,
    private readonly options: MomentOptions | undefined,
    memory: EmojiMemory,
    emojiEnabled: boolean,
  ) {
    this.speech = new SceneSpeech(0, options?.dialogue ?? [], options?.periods, options?.memory);
    this.emoji = new EmojiObserver(0, 1, { memory, enabled: emojiEnabled });
  }
  private remember(owner: object, clock: number) {
    if (!this.owners.has(owner) && this.owners.size >= 32) return false;
    this.owners.set(owner, clock);
    return true;
  }
  request(target: TapTarget, clock: number, minutes: number, profile: DialogueProfile) {
    if (
      this.options?.enabled === false ||
      clock - (this.greeted.get(target.owner) ?? -Infinity) < 5 ||
      !this.remember(target.owner, clock)
    )
      return false;
    const admitted = this.speech.admit(
      {
        key: {},
        requested: true,
        kind: profile === 'greeting' ? 'greet' : 'talk',
        speakers: [
          { owner: target.owner, member: 0, figure: target.agent.people?.[0]?.figure ?? 'adult' },
        ],
        profiles: [profile],
        context: { minutes, rain: 0, wind: 0, delivery: 'utterance', figures: [] },
        valid: () => this.owners.has(target.owner),
        stationary: () => false,
      },
      MOMENTS.scene.capacity,
    );
    if (admitted) this.greeted.set(target.owner, clock);
    return admitted;
  }
  react(owner: object, clock: number, mood: EmojiMood, duration = 3) {
    if (!this.remember(owner, clock)) return;
    this.reactions.add(
      {
        owner,
        subject: 'person',
        mood,
        duration,
        eligible: true,
        speaking: false,
        expires: clock + 8,
      },
      clock,
    );
  }
  step(dt: number, zoom: number, clock: number, visible: ReadonlySet<object>) {
    const allowed = zoom >= MOMENTS.zoom;
    this.speech.step(dt, allowed, clock);
    for (const [owner, at] of this.owners) {
      const track = this.emoji.memory.get(owner);
      if (track) {
        track.eligible = visible.has(owner);
        track.speaking = this.speech.voiceActive(owner);
      }
      if (
        !visible.has(owner) ||
        (clock - at > 8 && !this.speech.busy(owner) && !this.emoji.cue(owner))
      ) {
        this.emoji.release(owner);
        this.owners.delete(owner);
      }
    }
    if (!allowed) this.reactions.clear();
    const requests = this.reactions.drain(
      clock,
      (owner) => visible.has(owner),
      (owner) => this.speech.voiceActive(owner),
    );
    this.emoji.step(
      dt,
      zoom,
      { clock, emojiTime: { clock, dt } } as LifeEnv,
      [],
      [],
      [],
      [],
      requests,
    );
  }
  attach(owner: object, agent: VisibleAgent) {
    const speech = this.speech.speech(owner),
      emoji = this.emoji.cue(owner);
    if (speech) agent.speech = speech;
    else if (emoji) agent.emoji = emoji;
  }
  clear() {
    this.speech.clear();
    this.emoji.dispose();
    this.reactions.clear();
    this.owners.clear();
  }
}

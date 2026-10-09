/** Peddler expression never participates in ordinary scene capacity or history. */
import { SPEECH_ZOOM, type DialogueChoice, type GreetingPeriods } from '@atlas/shared';
import { DialogueSelector, type DialogueContext } from './dialogue';
import { MOMENTS, type SpeechCue } from './moments';
import { random } from './random';
import type { PeddlerOwner, PeddlerSignals } from './peddlers';

type Track = {
  selector: DialogueSelector;
  rng: () => number;
  clock: number;
  until: number;
  cue?: SpeechCue;
  hovered: boolean;
  hoverAt: number;
  stop: number;
  leaving: boolean;
  resume: number;
  serial: number;
  event?: 'hover' | 'leaving';
};
export class PeddlerCaller {
  private tracks = new WeakMap<PeddlerOwner, Track>();
  constructor(
    private readonly choices: readonly DialogueChoice[] = [],
    private readonly periods?: Readonly<GreetingPeriods>,
  ) {}
  state(owner: PeddlerOwner) {
    let track = this.tracks.get(owner);
    if (!track) {
      track = {
        selector: new DialogueSelector(owner.seed ^ 0x742813ad, this.choices, this.periods),
        rng: random(owner.seed ^ 0x297f9d13),
        clock: 0,
        until: 0,
        hovered: false,
        hoverAt: -Infinity,
        stop: 0,
        leaving: false,
        resume: 0,
        serial: 0,
      };
      this.tracks.set(owner, track);
    }
    return track;
  }
  forget(owner: PeddlerOwner) {
    this.tracks.delete(owner);
  }
  hide(owner: PeddlerOwner) {
    const t = this.state(owner);
    t.cue = undefined;
    t.hovered = false;
    t.stop = owner.callToken;
    t.leaving = owner.leaving;
    t.resume = owner.resumeToken;
  }
  step(owner: PeddlerOwner, dt: number, env: PeddlerSignals, enabled: boolean, hovered: boolean) {
    const t = this.state(owner);
    t.clock += dt;
    if (t.clock >= t.until) t.cue = undefined;
    if (!enabled) {
      this.hide(owner);
      return;
    }
    let event: 'hover' | 'leaving' | undefined;
    let trigger = false,
      clearing = false;
    if (owner.leaving && !t.leaving) {
      event = 'leaving';
      trigger = true;
    } else if (hovered && !t.hovered && t.clock >= t.hoverAt + 8) {
      event = 'hover';
      trigger = true;
      t.hoverAt = t.clock;
    } else if (owner.resumeToken !== t.resume) {
      clearing = true;
      trigger = true;
    } else if (owner.callToken !== t.stop) trigger = true;
    t.hovered = hovered;
    t.stop = owner.callToken;
    t.leaving = owner.leaving;
    t.resume = owner.resumeToken;
    if (
      !trigger ||
      (owner.leaving && event !== 'leaving') ||
      (env.wet && owner.canopy === 0 && event !== 'leaving')
    )
      return;
    t.serial++;
    t.event = event;
    t.cue = undefined;
    t.until = t.clock;
    // A bell event is always observed; voice at ordinary bell stops is one in three.
    if (owner.config.call === 'bell' && !event && !clearing && t.rng() >= 1 / 3) return;
    const base: DialogueContext = {
      minutes: env.minutes ?? 0,
      rain: env.rain,
      wind: env.wind?.strength ?? 0,
      sunAltitude: env.sunAltitude,
      clearing,
      figures: ['adult'],
      profiles: ['peddler-call'],
      delivery: 'utterance',
      peddler: { goods: owner.config.id, event },
    };
    const tiers =
      event === 'leaving' ? (['event'] as const) : (['event', 'weather', 'plain'] as const);
    for (const tier of tiers) {
      const entry = t.selector.choose('talk', { ...base, peddler: { ...base.peddler!, tier } }, [
        owner,
      ]);
      if (!entry) continue;
      t.cue = {
        id: `peddler:${owner.identity}:${t.serial}`,
        exchangeId: entry.id,
        line: 0,
        member: 0,
      };
      t.until = t.clock + MOMENTS.scene.turn;
      break;
    }
  }
  cue(owner: PeddlerOwner, zoom?: number) {
    return zoom === undefined || zoom >= SPEECH_ZOOM ? this.state(owner).cue : undefined;
  }
}

/**
 * Event cues: while an event runs, a few of its people pray, wave or call out in turns. Each
 * person's turn is a fixed window of the simulation clock drawn from their identity, so the
 * same people react the same way in every replay and nothing is stored between frames.
 */
import type { DialogueChoice, DialogueOccasion, EmojiMood } from '@atlas/shared';
import { eventActor } from './event-actors';
import type { EmojiCue } from './emoji';
import type { SpeechCue } from './moments';
import type { VisibleAgent } from './simulate';

export const EVENT_CUES = {
  /** One turn lasts this long, s of the simulation clock; each person's turns are offset. */
  window: 6,
  /** The share of an event's people reacting in any turn, and the share of those who speak. */
  share: 0.05,
  speech: 0.4,
} as const;

/**
 * Moods by event, weighted. Processions pray and are moved; fluvial crowds wave white
 * handkerchiefs, pray the rosary and set off fireworks from the banks (Radio Veritas Asia
 * 2025; Catholics & Cultures 2016); parades draw photos, waves and the bands' music; a Mass
 * prays.
 */
export const EVENT_MOODS: Record<DialogueOccasion, readonly { mood: EmojiMood; weight: number }[]> =
  {
    procession: [
      { mood: 'pray', weight: 3 },
      { mood: 'moved', weight: 2 },
      { mood: 'festive', weight: 2 },
      { mood: 'photo', weight: 1 },
    ],
    fluvial: [
      { mood: 'wave', weight: 3 },
      { mood: 'pray', weight: 2 },
      { mood: 'fireworks', weight: 1 },
      { mood: 'festive', weight: 1 },
      { mood: 'photo', weight: 1 },
    ],
    parade: [
      { mood: 'wave', weight: 2 },
      { mood: 'photo', weight: 2 },
      { mood: 'music', weight: 2 },
      { mood: 'thumbs', weight: 1 },
      { mood: 'festive', weight: 1 },
    ],
    mass: [
      { mood: 'pray', weight: 4 },
      { mood: 'moved', weight: 2 },
      { mood: 'love', weight: 1 },
    ],
  };

/** The cheers (`dialogue.json` kind `cheer`) for each event kind, by exchange id. */
export function eventCheers(choices: readonly DialogueChoice[] | undefined) {
  const out: Record<DialogueOccasion, string[]> = {
    procession: [],
    fluvial: [],
    parade: [],
    mass: [],
  };
  for (const choice of choices ?? [])
    if (choice.kind === 'cheer')
      for (const occasion of choice.conditions?.occasions ?? []) out[occasion].push(choice.id);
  return out;
}

const hash = (text: string, n: number) => {
  let h = Math.imul(n ^ 0x2c1b3c6d, 0x297a2d39);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
};
/** A stable key for an event person: its event identity, else its candle seed (river banks). */
const keyOf = (agent: VisibleAgent) =>
  eventActor(agent) ?? (agent.candleSeed !== undefined ? `seed:${agent.candleSeed}` : undefined);

/**
 * Give this frame's event people their cues: in each turn about `share` of them react, a
 * `speech` share of those with one of the event's cheers, the rest with one of its moods.
 * Only people on foot take a cue; objects, crews aboard and vehicles never do.
 */
export function assignEventCues(
  agents: readonly VisibleAgent[],
  occasion: DialogueOccasion,
  clock: number,
  options: { cheers: readonly string[]; emoji: boolean },
) {
  const moods = EVENT_MOODS[occasion];
  const total = moods.reduce((sum, m) => sum + m.weight, 0);
  for (const agent of agents) {
    if (agent.kind !== 'person' || agent.prop || agent.aboard || agent.vehicle) continue;
    const key = keyOf(agent);
    if (key === undefined) continue;
    const offset = (hash(key, 0) % 1000) / 1000;
    const turn = Math.floor(clock / EVENT_CUES.window + offset);
    const roll = hash(key, turn + 1);
    if ((roll % 10_000) / 10_000 >= EVENT_CUES.share) continue;
    const id = `event:${key}`;
    const pick = hash(key, -turn - 1);
    if (options.cheers.length && (pick % 1000) / 1000 < EVENT_CUES.speech) {
      const cue: SpeechCue = {
        id,
        exchangeId: options.cheers[(pick >>> 10) % options.cheers.length]!,
        line: 0,
      };
      agent.speech = cue;
      continue;
    }
    if (!options.emoji) continue;
    let at = (((pick >>> 10) % 10_000) / 10_000) * total;
    const mood = moods.find((m) => (at -= m.weight) < 0)?.mood ?? moods[0]!.mood;
    const cue: EmojiCue = { id, subject: 'person', mood };
    agent.emoji = cue;
  }
}

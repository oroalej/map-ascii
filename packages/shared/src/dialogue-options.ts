/** Browser-safe dialogue metadata: validation schemas stay out of runtime bundles. */
import type {
  DialogueAnchor,
  DialogueCatalog,
  DialogueChoice,
  DialogueProfile,
  GreetingPeriods,
} from './dialogue';

export const SCENE_PROFILES: readonly DialogueProfile[] = [
  'vendor-order',
  'vendor-thanks',
  'transit',
  'companion',
];
export const LOOK_ANCHORS: readonly DialogueAnchor[] = ['monument', 'fountain', 'plaza'];
export const DIALOGUE_WEATHER = {
  rain: 0.5,
  heavyRain: 0.8,
  easing: 0.2,
  breeze: 0.4,
  gust: 0.9,
  daylightStart: 360,
  daylightEnd: 1080,
} as const;

export const DEFAULT_GREETING_PERIODS: Readonly<GreetingPeriods> = {
  morningStart: 300,
  afternoonStart: 720,
  eveningStart: 1080,
};

export const dialogueChoices = (catalog: DialogueCatalog): DialogueChoice[] =>
  catalog.exchanges.map(({ id, kind, period, lines, profile, conditions, speakers, delivery }) => ({
    id,
    kind,
    period,
    turns: lines.length,
    ...(profile && { profile }),
    ...(conditions && { conditions }),
    ...(speakers && { speakers }),
    ...(delivery && { delivery }),
  }));

export const dialogueDelivery = (entry: Pick<DialogueChoice, 'kind' | 'delivery'>) =>
  entry.delivery ?? (entry.kind === 'look' ? 'utterance' : 'exchange');

export function greetingPeriod(
  minutes: number,
  periods: Readonly<GreetingPeriods> = DEFAULT_GREETING_PERIODS,
): NonNullable<DialogueChoice['period']> {
  return minutes >= periods.morningStart && minutes < periods.afternoonStart
    ? 'morning'
    : minutes >= periods.afternoonStart && minutes < periods.eveningStart
      ? 'afternoon'
      : 'evening';
}

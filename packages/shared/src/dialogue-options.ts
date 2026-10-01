/** Browser-safe dialogue metadata: validation schemas stay out of runtime bundles. */
import type { DialogueCatalog, DialogueChoice, GreetingPeriods } from './dialogue';

export const DEFAULT_GREETING_PERIODS: Readonly<GreetingPeriods> = {
  morningStart: 300,
  afternoonStart: 720,
  eveningStart: 1080,
};

export const dialogueChoices = (catalog: DialogueCatalog): DialogueChoice[] =>
  catalog.exchanges.map(({ id, kind, period, lines }) => ({
    id,
    kind,
    period,
    turns: lines.length,
  }));

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

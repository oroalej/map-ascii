/** Browser-safe dialogue metadata: validation schemas stay out of runtime bundles. */
import type { DialogueCatalog, DialogueChoice } from './dialogue';

export const dialogueChoices = (catalog: DialogueCatalog): DialogueChoice[] =>
  catalog.exchanges.map(({ id, kind, period, lines }) => ({
    id,
    kind,
    period,
    turns: lines.length,
  }));

export function greetingPeriod(minutes: number): NonNullable<DialogueChoice['period']> {
  return minutes >= 300 && minutes < 720
    ? 'morning'
    : minutes >= 720 && minutes < 1080
      ? 'afternoon'
      : 'evening';
}

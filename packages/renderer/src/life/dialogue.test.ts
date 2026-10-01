import { describe, expect, it } from 'vitest';
import type { DialogueChoice } from '@atlas/shared';
import {
  DialogueMemory,
  DialogueSelector,
  dialogueEligible,
  type DialogueContext,
} from './dialogue';

const context: DialogueContext = { minutes: 720, rain: 0, wind: 0, figures: ['adult', 'adult'] };
const entries: DialogueChoice[] = Array.from({ length: 12 }, (_, i) => ({
  id: `chat-${i}`,
  kind: 'talk',
  turns: 2,
  profile: 'reunion',
  speakers: [0, 1],
}));
describe('contextual dialogue', () => {
  it('records only admitted choices and relaxes older history before newer history', () => {
    const selector = new DialogueSelector(1, entries);
    const owners = [{}];
    const chosen = selector.choose('talk', context, owners, false)!;
    expect(selector.memory.recent).toEqual([]);
    selector.admit(chosen, owners);
    expect(selector.memory.recent).toEqual([chosen.id]);
    selector.memory.remember('newer', owners);
    expect(selector.memory.rank(chosen.id, owners)).toBeLessThan(
      selector.memory.rank('newer', owners),
    );
  });
  it('exhausts a stable pool without repeats, including across bag boundaries', () => {
    const selector = new DialogueSelector(1, entries),
      owners = [{}, {}];
    const selected = Array.from({ length: 36 }, () => selector.choose('talk', context, owners)!.id);
    for (let i = 0; i < 36; i += 12) expect(new Set(selected.slice(i, i + 12)).size).toBe(12);
    for (let i = 1; i < selected.length; i++) expect(selected[i]).not.toBe(selected[i - 1]);
  });
  it('shares bounded recent history across tiles and resets on world disposal', () => {
    const memory = new DialogueMemory(),
      owners = [{}, {}];
    const a = new DialogueSelector(1, entries, undefined, memory);
    const b = new DialogueSelector(1, entries, undefined, memory);
    const first = a.choose('talk', context, owners)!;
    expect(b.choose('talk', context, owners)!.id).not.toBe(first.id);
    for (let i = 0; i < 100; i++) a.choose('talk', context, owners);
    expect(memory.recent).toHaveLength(8);
    memory.clear();
    expect(memory.recent).toHaveLength(0);
  });
  it('requires real anchors, supported speakers, context and actual service events', () => {
    const base = entries[0]!;
    expect(
      dialogueEligible({ ...base, profile: 'directions', conditions: { anchor: 'stop' } }, context),
    ).toBe(false);
    expect(
      dialogueEligible(
        { ...base, profile: 'directions', conditions: { anchor: 'stop' } },
        { ...context, anchors: ['stop'] },
      ),
    ).toBe(true);
    expect(dialogueEligible({ ...base, speakers: [0, 2] }, context)).toBe(false);
    expect(dialogueEligible({ ...base, profile: 'school' }, context)).toBe(false);
    expect(dialogueEligible({ ...base, profile: 'vendor-order' }, context)).toBe(false);
    const transit = {
      ...base,
      profile: 'transit' as const,
      conditions: { event: 'arrival' as const },
    };
    expect(dialogueEligible(transit, { ...context, profiles: ['transit'] })).toBe(false);
    expect(dialogueEligible(transit, { ...context, profiles: ['transit'], arrival: true })).toBe(
      true,
    );
  });
  it('allows rain remarks only from shelters and easing only after observed decline', () => {
    const entry = {
      ...entries[0]!,
      profile: 'weather' as const,
      conditions: { weather: 'easing' as const },
    };
    expect(dialogueEligible(entry, { ...context, rain: 0.6, easing: true })).toBe(false);
    expect(dialogueEligible(entry, { ...context, rain: 0.6, sheltered: true })).toBe(false);
    expect(dialogueEligible(entry, { ...context, rain: 0.6, sheltered: true, easing: true })).toBe(
      true,
    );
  });
});

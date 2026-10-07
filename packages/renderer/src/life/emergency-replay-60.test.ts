import { expect, it } from 'vitest';
import { emergencyReplay } from './testing/emergency-replay';
it.each(['ambulance', 'police', 'fire'] as const)(
  'replays %s phases deterministically at 60 Hz',
  (kind) => {
    const { a, b, phases } = emergencyReplay(60, kind);
    expect(a).toStrictEqual(b);
    expect(phases).toContain(
      kind === 'ambulance' ? 'cleared' : kind === 'police' ? 'patrol' : 'returning',
    );
  },
);

import { expect, it } from 'vitest';
import { emergencyReplay } from './testing/emergency-replay';
it.each(['ambulance', 'police', 'fire'] as const)(
  'replays %s phases deterministically at 120 Hz',
  (kind) => {
    const { a, b, phases } = emergencyReplay(120, kind);
    expect(a).toStrictEqual(b);
    expect(phases).toContain(
      kind === 'ambulance' ? 'cleared' : kind === 'police' ? 'call' : 'returning',
    );
  },
);

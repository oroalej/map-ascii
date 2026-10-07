import { expect, it } from 'vitest';
import { emergencyReplay } from './testing/emergency-replay';
it.each(['ambulance', 'police', 'fire'] as const)(
  'replays %s phases deterministically at 30 Hz',
  (kind) => {
    const { a, b, phases } = emergencyReplay(30, kind);
    expect(a).toStrictEqual(b);
    expect(phases).toContain(
      kind === 'ambulance' ? 'parked' : kind === 'police' ? 'call' : 'onscene',
    );
  },
);

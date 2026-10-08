import { expect, it } from 'vitest';
import { hauntLampBrightness, hauntLampGlsl } from './folklore-lighting';
import { lightByte, LampState } from './lights';
import { glyphFragmentFor } from '../shaders/glyph';

it('bounds complete haunt brightness to two smooth cycles in sliding one-second windows', () => {
  for (const state of [LampState.working, LampState.flicker, LampState.candle])
    for (let seed = 0; seed < 32; seed++)
      for (const start of [0.137, 0.411, 1.823, 12.513, 70.919]) {
        const byte = lightByte(state, seed);
        let previous = hauntLampBrightness(start, byte),
          rising = 0,
          falling = 0;
        let minimum = previous,
          maximum = previous,
          maximumStep = 0;
        for (let i = 1; i <= 240; i++) {
          const next = hauntLampBrightness(start + i / 240, byte);
          minimum = Math.min(minimum, next);
          maximum = Math.max(maximum, next);
          maximumStep = Math.max(maximumStep, Math.abs(next - previous));
          if (previous < 0.675 && next >= 0.675) rising++;
          if (previous >= 0.675 && next < 0.675) falling++;
          previous = next;
        }
        expect(rising).toBeLessThanOrEqual(2);
        expect(falling).toBeLessThanOrEqual(2);
        expect(minimum).toBeGreaterThanOrEqual(0.35);
        expect(maximum).toBeLessThanOrEqual(1);
        expect(maximumStep).toBeLessThan(0.018);
      }
});

it('uses the shared slow profile only inside the active haunt and motion gate', () => {
  const shader = glyphFragmentFor({ focus: false, effectClocks: false, seasonal: false });
  expect(shader).toContain(hauntLampGlsl);
  expect(shader).toContain('return hauntLamp(time, g);');
  expect(shader).toContain('u_shimmer && u_hauntCount>0');
  expect(shader).not.toContain('floor(time*17.0)');
});

import { offsetUtility } from '@atlas/shared';
import type { CandleFixture } from './seasonal-candles';

export const candleKey = (c: CandleFixture) => `${c.seed}/${c.at[0]}/${c.at[1]}`;
export type CandleFlareUniforms = { center: readonly number[]; radius: readonly number[] };
export const candleFlareStrength = (age: number) => Math.max(0, 1 - Math.max(0, age) / 3) ** 2;
/** One geographic flare, replaced only by another receipted candle tap. */
export class CandleFlare {
  constructor(
    private readonly candle: { at: readonly [number, number]; seed: number },
    private readonly start: number,
  ) {}
  uniforms(
    time: number,
    toCell: (lng: number, lat: number) => [number, number],
  ): CandleFlareUniforms | undefined {
    const strength = candleFlareStrength(time - this.start);
    if (!strength) return;
    const at = toCell(...this.candle.at),
      east = toCell(...offsetUtility([...this.candle.at], 1.8, 0)),
      north = toCell(...offsetUtility([...this.candle.at], 0, 1.8));
    return {
      center: [...at, strength, this.candle.seed & 31],
      radius: [
        Math.max(0.75, Math.hypot(east[0] - at[0], east[1] - at[1])),
        Math.max(0.75, Math.hypot(north[0] - at[0], north[1] - at[1])),
      ],
    };
  }
}
export const candleFlareGlsl = /* glsl */ `
uniform vec4 u_candleFlare;
uniform vec2 u_candleFlareRadius;
float candleFlareAt(int g, vec2 cell) {
  if (!u_shimmer || u_candleFlare.z<=0.0 || (g>>3)!=int(u_candleFlare.w+0.5)) return 0.0;
  vec2 uv=(cell-u_candleFlare.xy)/u_candleFlareRadius;
  return dot(uv,uv)<=1.0 ? u_candleFlare.z : 0.0;
}
`;

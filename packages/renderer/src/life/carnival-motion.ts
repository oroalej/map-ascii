import { SeasonalPart } from './seasonal-glyphs';

export const CARNIVAL_MOTION = { carousel: 0.45, wheel: 0.42, cars: 0.7 } as const;
export const isCarnivalMotionPart = (part: number) =>
  part >= SeasonalPart.carouselMotion && part <= SeasonalPart.bumperMotion;

/** Two nine-bit local coordinates reuse the fixture's ten-bit glyph and eight-bit info slots. */
export function encodeCarnivalUv(u: number, v: number): number {
  const quantize = (n: number) => Math.round((Math.max(-1, Math.min(1, n)) + 1) * 255.5);
  return quantize(u) | (quantize(v) << 9);
}
export const decodeCarnivalUv = (packed: number): [number, number] => [
  (packed & 511) / 255.5 - 1,
  ((packed >> 9) & 511) / 255.5 - 1,
];

/** CPU reference for the shader's bounded, overhead ride motion. */
export function carnivalPose(time: number, reducedMotion = false) {
  const t = reducedMotion || !Number.isFinite(time) ? 0 : time;
  return {
    carousel: t * CARNIVAL_MOTION.carousel,
    gondolas: Array.from({ length: 8 }, (_, i): [number, number] => {
      const a = t * CARNIVAL_MOTION.wheel + (i * Math.PI) / 4;
      return [Math.cos(a) * 0.18, Math.sin(a) * 0.8];
    }),
    cars: Array.from({ length: 4 }, (_, i): [number, number] => {
      const a = t * CARNIVAL_MOTION.cars + (i * Math.PI) / 2;
      return [Math.sin(a) * 0.56, Math.cos(a) * 0.62];
    }),
  };
}

/** World-local samples animate on the existing time uniform without repacking any cells. */
export const carnivalMotionGlsl = /* glsl */ `
vec3 carnivalPaint(int tint) {
  return tint == 1 ? vec3(1.0, 0.06, 0.16) : tint == 2 ? vec3(0.02, 0.82, 0.58) :
    tint == 3 ? vec3(1.0, 0.12, 0.50) : tint == 4 ? vec3(0.12, 0.38, 1.0) :
    tint == 5 ? vec3(0.99, 0.95, 0.76) : vec3(1.0, 0.67, 0.08);
}
vec4 carnivalSurface(int part, vec2 uv, float time) {
  if (part == ${SeasonalPart.carouselMotion}) {
    int stripe = int(mod(floor((atan(uv.y, uv.x) - time * ${CARNIVAL_MOTION.carousel} + 3.14159265359) * 6.0 / 3.14159265359), 2.0));
    int tint = length(uv) < 0.3 ? (stripe == 1 ? 2 : 5) : (stripe == 1 ? 1 : 0);
    return vec4(carnivalPaint(tint), 1.0);
  }
  vec4 floorPaint = vec4(vec3(0.07, 0.38, 0.43), 0.25);
  if (part == ${SeasonalPart.wheelMotion}) {
    if (abs(uv.x) < 0.08 || abs(uv.y) < 0.05 || abs(abs(uv.x) - (0.25 + abs(uv.y) * 0.4)) < 0.09)
      floorPaint = vec4(0.61, 0.76, 0.78, 1.0);
    if (abs(uv.x) < 0.13) floorPaint = vec4(1.0, 0.97, 0.86, 1.0);
    for (int i = 0; i < 8; i++) {
      float a = time * ${CARNIVAL_MOTION.wheel} + float(i) * 0.78539816339;
      vec2 at = vec2(cos(a) * 0.18, sin(a) * 0.8);
      if (abs(uv.x - at.x) < 0.2 && abs(uv.y - at.y) < 0.065) {
        int tint = i % 4 == 0 ? 1 : i % 4 == 1 ? 0 : i % 4 == 2 ? 2 : 3;
        return vec4(carnivalPaint(tint), 1.0);
      }
    }
  } else {
    if ((int(floor((uv.x + 1.0) * 4.0)) + int(floor((uv.y + 1.0) * 5.0))) % 2 == 0)
      floorPaint.rgb = vec3(0.26, 0.12, 0.42);
    for (int i = 0; i < 4; i++) {
      float a = time * ${CARNIVAL_MOTION.cars} + float(i) * 1.57079632679;
      vec2 at = vec2(sin(a) * 0.56, cos(a) * 0.62);
      if (abs(uv.x - at.x) < 0.145 && abs(uv.y - at.y) < 0.16)
        return vec4(carnivalPaint(i == 3 ? 0 : i + 1), 1.0);
    }
  }
  return floorPaint;
}
`;

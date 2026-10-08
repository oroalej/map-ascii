/** A render-grid-local patch. Its centre has already had the world origin subtracted. */
export type CursorWind = {
  at: readonly [number, number];
  dir: readonly [number, number];
  strength: number;
  radius: number;
  aspect: number;
};
export const CURSOR_WIND = { radius: 8, full: 40, max: 1, averageMs: 120, decayMs: 600 } as const;

export function cursorStrength(x: number, y: number, cursor?: CursorWind | null): number {
  if (!cursor || cursor.strength <= 0 || cursor.radius <= 0) return 0;
  const distance = Math.hypot(x - cursor.at[0], (y - cursor.at[1]) * cursor.aspect);
  return cursor.strength * Math.max(0, 1 - distance / cursor.radius);
}

/** Global strength is already scaled. The zero-local branch preserves the legacy arithmetic. */
export function combineWind(
  strength: number,
  dir: readonly [number, number],
  x: number,
  y: number,
  cursor?: CursorWind | null,
): { strength: number; dir: readonly [number, number] } {
  const local = cursorStrength(x, y, cursor);
  if (local === 0) return { strength, dir };
  const vx = dir[0] * strength + cursor!.dir[0] * local;
  const vy = dir[1] * strength + cursor!.dir[1] * local;
  const length = Math.hypot(vx, vy);
  return { strength: length, dir: length > 1e-9 ? [vx / length, vy / length] : dir };
}

export function cursorUniforms(cursor?: CursorWind | null) {
  return {
    u_cursorWind: cursor ? [...cursor.at, cursor.strength, cursor.radius] : [0, 0, 0, 1],
    u_cursorWindDir: cursor?.dir ?? [1, 0],
    u_cursorAspect: cursor?.aspect ?? 1,
  };
}

export const cursorWindGlsl = /* glsl */ `
uniform vec4 u_cursorWind; // grid-local x/y, independent strength, radius in horizontal cells
uniform vec2 u_cursorWindDir;
uniform float u_cursorAspect;
float cursorStrength(vec2 cell) {
  if (u_cursorWind.z <= 0.0) return 0.0;
  vec2 d = (cell - u_cursorWind.xy) * vec2(1.0, u_cursorAspect);
  return u_cursorWind.z * max(0.0, 1.0 - length(d) / u_cursorWind.w);
}
float combineWind(float global, vec2 globalDir, vec2 cell, out vec2 dir) {
  float local = cursorStrength(cell);
  dir = globalDir;
  if (local <= 0.0) return global;
  vec2 velocity = global * globalDir + local * u_cursorWindDir;
  float strength = length(velocity);
  if (strength > 1e-9) dir = velocity / strength;
  return strength;
}`;

import type { packLife } from '../src/life/draw';

type Args = Parameters<typeof packLife>;
export type PuffPacking = (
  out: Args[0],
  grid: Args[1],
  agents: Args[2],
  theme: Args[3],
  glyphIndex: Args[4],
  sun?: Args[5],
  glyphs?: Args[6],
  puffs?: Float64Array,
) => number;

/** Select once per frozen graph, before correctness checks or timed samples. */
export function adaptPuffPacking(pack: typeof packLife, source: string): PuffPacking {
  const start = source.indexOf('export function packLife(');
  const end = source.indexOf('): number', start);
  if (start < 0 || end < start) throw new Error('Unrecognized packLife signature');
  if (/\bmetadata\s*:/.test(source.slice(start, end)))
    return (out, grid, agents, theme, glyphIndex, sun, glyphs, puffs) =>
      pack(out, grid, agents, theme, glyphIndex, sun, glyphs, undefined, puffs);
  // Historical graphs predate metadata: their eighth argument is puffs, or is ignored.
  const legacy = pack as unknown as PuffPacking;
  return (out, grid, agents, theme, glyphIndex, sun, glyphs, puffs) =>
    legacy(out, grid, agents, theme, glyphIndex, sun, glyphs, puffs);
}

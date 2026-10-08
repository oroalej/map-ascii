export type TilePair = {
  key: string;
  z: number;
  round: number;
  first: 'baseline' | 'candidate';
  baselineMs: number;
  candidateMs: number;
};
export function median(values: readonly number[]): number {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw new Error('Expected finite nonempty measurements');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function firstArm(tile: number, round: number): TilePair['first'] {
  return (tile + round) % 2 === 0 ? 'baseline' : 'candidate';
}
export function compareTilePairs(pairs: readonly TilePair[]) {
  if (!pairs.length || pairs.some((p) => p.baselineMs <= 0 || p.candidateMs <= 0))
    throw new Error('Expected positive paired timings');
  const baselineMs = median(pairs.map((p) => p.baselineMs));
  const candidateMs = median(pairs.map((p) => p.candidateMs));
  const changePercent = ((candidateMs - baselineMs) / baselineMs) * 100;
  const rounds = [...new Set(pairs.map((p) => p.round))]
    .sort((a, b) => a - b)
    .map((round) => {
      const rows = pairs.filter((p) => p.round === round);
      const a = median(rows.map((p) => p.baselineMs));
      const b = median(rows.map((p) => p.candidateMs));
      return { round, changePercent: ((b - a) / a) * 100 };
    });
  const spreadPercent =
    Math.max(...rounds.map((r) => r.changePercent)) -
    Math.min(...rounds.map((r) => r.changePercent));
  return { baselineMs, candidateMs, changePercent, rounds, spreadPercent };
}
export function tileGate(changePercent: number, controlSpreadPercent: number, stable: boolean) {
  if (![changePercent, controlSpreadPercent].every(Number.isFinite) || controlSpreadPercent < 0)
    throw new Error('Invalid gate measurements');
  const allowancePercent = Math.max(5, 2 * controlSpreadPercent);
  return { allowancePercent, pass: stable && changePercent <= allowancePercent };
}

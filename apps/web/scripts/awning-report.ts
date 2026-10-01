export type AwningSample = { block: number; ms: number };
export type AwningEvidence = {
  samples: AwningSample[];
  supported: boolean;
  renderer: string | null;
  buildings: number;
  awnings: number;
  errors: string[];
  stable: boolean;
  disjoint: number;
};

const stats = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    p50: values[Math.floor(values.length * 0.5)] ?? null,
    p95: values[Math.floor(values.length * 0.95)] ?? null,
  };
};

/** An unsupported or incomplete measurement is never a successful acceptance run. */
export function awningReport(evidence: AwningEvidence) {
  const blocks = Array.from({ length: 6 }, (_, block) => {
    const values = evidence.samples
      .filter((s) => s.block === block && Number.isFinite(s.ms) && s.ms >= 0)
      .slice(20, 80)
      .map((s) => s.ms);
    return { block, on: block % 2 === 1, values, ...stats(values) };
  });
  const off = stats(blocks.filter((b) => !b.on).flatMap((b) => b.values));
  const on = stats(blocks.filter((b) => b.on).flatMap((b) => b.values));
  const share = evidence.buildings ? evidence.awnings / evidence.buildings : null;
  const pendingReasons = [
    ...(!evidence.supported ? ['GPU timer queries unavailable'] : []),
    ...(!evidence.renderer || /swiftshader|llvmpipe|software/i.test(evidence.renderer)
      ? ['Hardware GPU not identified']
      : []),
    ...(!evidence.stable ? ['Scene geometry changed'] : []),
    ...(evidence.disjoint ? ['GPU clock disjoint during capture'] : []),
    ...(blocks.some((b) => b.count < 60) ? ['Insufficient valid samples'] : []),
    ...(!evidence.buildings || !evidence.awnings
      ? ['Scene does not exercise visible awnings']
      : []),
  ];
  const growth = on.p95 !== null && off.p95 !== null ? on.p95 - off.p95 : null;
  const limit = off.p95 === null ? null : Math.max(0.5, off.p95 * 0.1);
  const status =
    evidence.errors.length || (share !== null && share > 0.3)
      ? 'fail'
      : pendingReasons.length
        ? 'pending'
        : growth! > limit!
          ? 'fail'
          : 'pass';
  return {
    status,
    pendingReasons,
    off,
    on,
    blocks: blocks.map((b) => ({
      block: b.block,
      on: b.on,
      count: b.count,
      p50: b.p50,
      p95: b.p95,
    })),
    buildings: evidence.buildings,
    awnings: evidence.awnings,
    share,
    growthMs: growth,
    limitMs: limit,
    exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : 2,
  };
}

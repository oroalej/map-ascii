// @vitest-environment node
import { expect, it } from 'vitest';
import { awningReport, type AwningEvidence } from './awning-report';
const evidence = (): AwningEvidence => ({
  samples: Array.from({ length: 6 }, (_, block) =>
    Array.from({ length: 80 }, (_, i) => ({ block, ms: i < 20 ? 100 : block % 2 ? 1.1 : 1 })),
  ).flat(),
  supported: true,
  renderer: 'Hardware GPU',
  buildings: 100,
  awnings: 10,
  errors: [],
  stable: true,
  disjoint: 0,
});
it('discards each block warmup and accepts sufficient paired measurements', () => {
  expect(awningReport(evidence())).toMatchObject({
    status: 'pass',
    exitCode: 0,
    off: { count: 180, p95: 1 },
    on: { count: 180, p95: 1.1 },
  });
});
it('never accepts missing timings, software, changing geometry, or an empty scene', () => {
  for (const patch of [
    { supported: false },
    { samples: [] },
    { renderer: 'SwiftShader' },
    { stable: false },
    { disjoint: 1 },
    { buildings: 0 },
    { awnings: 0 },
  ])
    expect(awningReport({ ...evidence(), ...patch })).toMatchObject({
      status: 'pending',
      exitCode: 2,
    });
});
it('fails errors, excessive coverage, and a measured select regression', () => {
  for (const patch of [
    { errors: ['GL error'] },
    { awnings: 31 },
    { samples: evidence().samples.map((s) => ({ ...s, ms: s.block % 2 ? 2 : 1 })) },
  ])
    expect(awningReport({ ...evidence(), ...patch })).toMatchObject({
      status: 'fail',
      exitCode: 1,
    });
});

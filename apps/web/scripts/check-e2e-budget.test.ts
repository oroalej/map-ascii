// @vitest-environment node
import { expect, it } from 'vitest';
import { checkShardDuration } from './check-e2e-budget';

it('accepts the boundary and rejects an over-budget shard with its identity', () => {
  expect(checkShardDuration({ stats: { duration: 200_000 } }, '1/2')).toBe(200_000);
  expect(() => checkShardDuration({ stats: { duration: 200_001 } }, '1/2')).toThrow(
    'E2E shard 1/2: 200.001 s exceeds',
  );
});

it.each([
  null,
  {},
  { stats: {} },
  { stats: { duration: '190000' } },
  { stats: { duration: -1 } },
  { stats: { duration: Infinity } },
])('fails closed for a missing or malformed report: %j', (report) => {
  expect(() => checkShardDuration(report, '2/2')).toThrow('missing or invalid');
});

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const E2E_SHARD_BUDGET_MS = 200_000;

export function checkShardDuration(report: unknown, shard: string) {
  const duration = (report as { stats?: { duration?: unknown } } | null)?.stats?.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
    throw new Error(`E2E shard ${shard}: missing or invalid Playwright stats.duration`);
  if (duration > E2E_SHARD_BUDGET_MS)
    throw new Error(
      `E2E shard ${shard}: ${(duration / 1000).toFixed(3)} s exceeds the 200 s suite budget; profile the slow tests before adding browser work`,
    );
  return duration;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const arg = (name: string) =>
    process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const report = arg('report');
  if (!report) throw new Error('Pass --report=<Playwright JSON report> and --shard=<index/count>');
  const shard = arg('shard') ?? 'unknown';
  const duration = checkShardDuration(JSON.parse(await readFile(report, 'utf8')), shard);
  console.log(`E2E shard ${shard}: ${(duration / 1000).toFixed(1)} s / 200 s`);
}

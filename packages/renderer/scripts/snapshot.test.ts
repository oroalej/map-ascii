// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { snapshotRevision } from './snapshot';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'ls-tree')
      return 'packages/renderer/src/life/simulate.ts\npackages/renderer/src/life/occupancy.ts\npackages/shared/src/index.ts';
    if (args[1]?.endsWith('pnpm-lock.yaml')) return 'same-lock\n';
    if (args[1]?.endsWith('simulate.ts'))
      return "import { helper } from './occupancy'; import { shared } from '@atlas/shared'; export { helper, shared };";
    if (args[1]?.endsWith('occupancy.ts')) return 'export const helper = "frozen-collision";';
    return 'export const shared = "frozen-shared";';
  }),
}));
const workspace = resolve('test-results');
let temporary: string | undefined;
afterEach(async () => {
  if (
    temporary &&
    dirname(temporary) === workspace &&
    basename(temporary).startsWith('snapshot-test-')
  )
    await rm(temporary, { recursive: true, force: true });
});
it('copies helper sources and redirects shared aliases into the frozen source graph', async () => {
  await mkdir(workspace, { recursive: true });
  temporary = await mkdtemp(join(workspace, 'snapshot-test-'));
  await writeFile(join(temporary, 'pnpm-lock.yaml'), 'same-lock\n');
  for (const name of ['renderer', 'shared'])
    await mkdir(join(temporary, 'packages', name, 'node_modules'), { recursive: true });
  const destination = join(temporary, 'frozen');
  const snapshot = await snapshotRevision(temporary, 'baseline', destination);
  const simulation = await readFile(
    join(destination, 'packages/renderer/src/life/simulate.ts'),
    'utf8',
  );
  expect(simulation).toContain("from './occupancy'");
  expect(simulation).toContain("from '../../../shared/src/index.ts'");
  expect(simulation).not.toContain('@atlas/shared');
  expect(
    await readFile(join(destination, 'packages/renderer/src/life/occupancy.ts'), 'utf8'),
  ).toContain('frozen-collision');
  expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
}, 10_000);

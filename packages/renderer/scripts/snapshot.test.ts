// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { currentSourceHash, snapshotRevision, snapshotWorkingTree } from './snapshot';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'ls-tree' || args[0] === 'ls-files')
      return 'packages/renderer/src/life/simulate.ts\npackages/renderer/src/life/occupancy.ts\npackages/shared/src/index.ts';
    if (args[1]?.endsWith('pnpm-lock.yaml')) return 'same-lock\n';
    if (args[1]?.endsWith('simulate.ts'))
      return "import { helper } from './occupancy'; import { shared } from '@atlas/shared'; export { helper, shared };";
    if (args[1]?.endsWith('occupancy.ts')) return 'export const helper = "frozen-collision";';
    return 'export const shared = "frozen-shared";';
  }),
}));
const workspace = tmpdir();
let temporary: string | undefined;
afterEach(async () => {
  if (
    temporary &&
    dirname(temporary) === workspace &&
    basename(temporary).startsWith('snapshot-test-')
  )
    await rm(temporary, { recursive: true, force: true });
});
// eslint-disable-next-line no-restricted-syntax -- slow before the time-limit ban; tracked by the CI file budget
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

it('hashes the current sources when a tracked file is deleted from the working tree', async () => {
  await mkdir(workspace, { recursive: true });
  temporary = await mkdtemp(join(workspace, 'snapshot-test-'));
  const paths = [
    'packages/renderer/src/life/simulate.ts',
    'packages/renderer/src/life/occupancy.ts',
    'packages/shared/src/index.ts',
  ];
  for (const path of paths) {
    await mkdir(dirname(join(temporary, path)), { recursive: true });
    await writeFile(join(temporary, path), `export const source = '${path}';\n`);
  }
  const before = await currentSourceHash(temporary);
  for (const name of ['renderer', 'shared'])
    await mkdir(join(temporary, 'packages', name, 'node_modules'), { recursive: true });
  const frozen = await snapshotWorkingTree(temporary, join(temporary, 'current'));
  expect(frozen.hash).toBe(before);
  await writeFile(join(temporary, paths[0]!), 'export const source = "changed";');
  expect(await readFile(join(temporary, 'current', paths[0]!), 'utf8')).not.toContain('changed');
  await rm(join(temporary, paths[1]!));
  const after = await currentSourceHash(temporary);
  expect(after).toMatch(/^[a-f0-9]{64}$/);
  expect(after).not.toBe(before);
  expect(await currentSourceHash(temporary)).toBe(after);
});

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Preserve the complete runtime source graph; workspace aliases also point into the snapshot. */
export async function snapshotRevision(root: string, revision: string, destination: string) {
  const oldLock = execFileSync('git', ['show', `${revision}:pnpm-lock.yaml`], {
    cwd: root,
    encoding: 'utf8',
  }).replace(/\r\n/g, '\n');
  if (oldLock !== (await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')).replace(/\r\n/g, '\n'))
    throw new Error(
      'Baseline dependencies differ: compare revisions using the same pnpm-lock.yaml',
    );
  const paths = execFileSync(
    'git',
    [
      'ls-tree',
      '-r',
      '--name-only',
      revision,
      '--',
      'packages/renderer/src',
      'packages/shared/src',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
  return freezeSources(root, destination, paths, (path) =>
    execFileSync('git', ['show', `${revision}:${path}`], {
      cwd: root,
      encoding: 'utf8',
    }).replace(/\r\n/g, '\n'),
  );
}
async function freezeSources(
  root: string,
  destination: string,
  paths: string[],
  sourceOf: (path: string) => Promise<string> | string,
) {
  const hash = createHash('sha256');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'package.json'), '{"type":"module"}');
  for (const path of paths) {
    const source = await sourceOf(path);
    hash.update(path).update('\0').update(source);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    const alias = relative(
      dirname(target),
      join(destination, 'packages/shared/src/index.ts'),
    ).replaceAll('\\', '/');
    await writeFile(
      target,
      source.replace(
        /(['"])@atlas\/shared\1/g,
        (_match, quote: string) =>
          `${quote}${alias.startsWith('.') ? alias : './' + alias}${quote}`,
      ),
    );
  }
  for (const name of ['renderer', 'shared'])
    await symlink(
      join(root, 'packages', name, 'node_modules'),
      join(destination, 'packages', name, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  return {
    hash: hash.digest('hex'),
    path: (file: string) => pathToFileURL(resolve(destination, 'packages/renderer/src', file)).href,
  };
}
/** Freeze the working tree exactly like a revision, avoiding static-import/load-order bias. */
export async function snapshotCurrent(root: string, destination: string) {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages/renderer/src',
      'packages/shared/src',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && existsSync(join(root, p)))
    .sort();
  return freezeSources(root, destination, paths, async (p) =>
    (await readFile(join(root, p), 'utf8')).replace(/\r\n/g, '\n'),
  );
}
export async function currentSourceHash(root: string) {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages/renderer/src',
      'packages/shared/src',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .sort();
  const hash = createHash('sha256');
  for (const p of paths) {
    if (!existsSync(join(root, p))) continue;
    hash
      .update(p)
      .update('\0')
      .update((await readFile(join(root, p), 'utf8')).replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

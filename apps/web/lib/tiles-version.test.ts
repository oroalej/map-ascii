// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tilesVersion } from './tiles-version';

it('versions only archives matching their locked bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-version-'));
  const bytes = 'fixture archive';
  const hash = createHash('sha256').update(bytes).digest('hex');
  const pack = {
    city: { slug: 'fixture' },
    tilesLock: { files: { 'fixture.pmtiles': hash } },
  };
  try {
    expect(await tilesVersion(pack, directory)).toBeUndefined();
    await writeFile(join(directory, 'fixture.pmtiles'), bytes);
    expect(await tilesVersion(pack, directory)).toBe(hash.slice(0, 8));
    expect(await tilesVersion({ ...pack, tilesLock: undefined }, directory)).toBeUndefined();
    await writeFile(join(directory, 'fixture.pmtiles'), 'local rebuild');
    expect(await tilesVersion(pack, directory)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true });
  }
});

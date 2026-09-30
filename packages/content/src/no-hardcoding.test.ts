import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCityPacks } from './validate';

/**
 * The engine must stay city-agnostic (AGENTS.md, ROADMAP Phase 1): no registered city's slug or
 * name may appear in the renderer or the web app's source. City specifics come from the city
 * pack and the generated meta. Tests are exempt, since they may use a city as a fixture.
 */
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const engineDirs = [
  'packages/renderer/src',
  'apps/web/app',
  'apps/web/components',
  'apps/web/state',
];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.(ts|tsx|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('engine source', () => {
  it('names no registered city', async () => {
    const { packs } = await loadCityPacks();
    expect(packs.length).toBeGreaterThan(0);
    const terms = packs.flatMap(({ city }) => [city.slug, city.name.en]);
    const pattern = new RegExp(`\\b(${terms.map(escape).join('|')})\\b`, 'i');

    const hits: string[] = [];
    for (const dir of engineDirs) {
      for (const file of await sourceFiles(join(repo, dir))) {
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${file.slice(repo.length)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});

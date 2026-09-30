/**
 * `pnpm check:budgets`: check the static export against the size budgets in ARCHITECTURE.md §8,
 * after `pnpm build`. Initial JS is the gzipped scripts each city page loads (the tile worker
 * loads later, and `nomodule` polyfills load only in old browsers, so neither is counted); each
 * city's `<slug>.pmtiles` must stay under its cap. The page's own HTML, with the content inlined
 * in it, is reported alongside.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const MB = 1024 * KB;
const BUDGETS = { initialJs: 250 * KB, pmtiles: 40 * MB };

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'out');
const tiles = join(root, 'public', 'tiles');
const citiesDir = join(root, '..', '..', 'packages', 'content', 'cities');

if (!existsSync(out)) {
  console.error('✗ no static export in apps/web/out; run pnpm build first');
  process.exit(1);
}

const slugs = readdirSync(citiesDir).filter((slug) =>
  existsSync(join(citiesDir, slug, 'city.json')),
);
const rows: { what: string; size: number; budget: number }[] = [];
const notes: string[] = [];
const human = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${(n / KB).toFixed(0)} KB`);

for (const slug of slugs) {
  const html = readFileSync(join(out, `${slug}.html`), 'utf8');
  const scripts = new Set(
    [...html.matchAll(/<script\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/\snomodule\b/i.test(tag))
      .flatMap((tag) => /\ssrc="([^"]+)"/.exec(tag)?.[1] ?? []),
  );
  let js = 0;
  for (const src of scripts) js += gzipSync(readFileSync(join(out, src))).length;
  rows.push({ what: `/${slug} initial JS (gzipped)`, size: js, budget: BUDGETS.initialJs });
  notes.push(`/${slug} HTML (gzipped): ${human(gzipSync(html).length)}`);

  const pmtiles = join(tiles, `${slug}.pmtiles`);
  if (existsSync(pmtiles)) {
    rows.push({ what: `${slug}.pmtiles`, size: statSync(pmtiles).size, budget: BUDGETS.pmtiles });
  } else {
    console.warn(`! ${slug}.pmtiles: not present, not checked`);
  }
}

let over = false;
for (const { what, size, budget } of rows) {
  const ok = size < budget;
  over ||= !ok;
  console.log(`${ok ? '✓' : '✗'} ${what}: ${human(size)} of ${human(budget)}`);
}
for (const note of notes) console.log(`· ${note}`);
if (over) process.exit(1);

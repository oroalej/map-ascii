/**
 * `pnpm check:budgets`: check the static export against the size budgets in ARCHITECTURE.md §8,
 * after `pnpm build`. Initial JS is the gzipped scripts each city page loads (the tile worker
 * loads later, and `nomodule` polyfills load only in old browsers, so neither is counted). The
 * asynchronous map renderer has its own gzipped budget, and each city's `<slug>.pmtiles`
 * must stay under its cap. Each `<slug>.processions.json` has a 60 KiB gzip cap.
 * City HTML has a raw-size cap. Startup JSON counts automatic tile sidecars fetched before
 * the first tile frame: currently none (meta is inline; subdivisions, landmarks, processions
 * and emergency wait for readiness). Interaction-triggered requests are outside that set.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { canvasChunks, canvasEntries, gzippedChunks } from './chunk-budgets';
import { STARTUP_JSON_BUDGET, startupJsonSize } from './startup-json-budget';

const KB = 1024;
const MB = 1024 * KB;
const BUDGETS = {
  initialJs: 250 * KB,
  renderer: 120 * KB,
  canvasAsync: 200 * KB,
  cityHtml: 48 * KB,
  startupJson: STARTUP_JSON_BUDGET,
  pmtiles: 40 * MB,
  processions: 60 * KB,
  emergency: 32 * KB,
};

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
const chunks = join(out, '_next', 'static', 'chunks');
const rendererChunks = readdirSync(chunks)
  .filter((file) => file.endsWith('.js'))
  .map((file) => ({ path: join(chunks, file), source: readFileSync(join(chunks, file)) }))
  .filter(({ source }) => source.includes('webglcontextlost'));
if (rendererChunks.length !== 1) {
  console.error(`✗ expected one renderer chunk; found ${rendererChunks.length}`);
  process.exit(1);
}
const renderer = rendererChunks[0]!;
const rendererSize = gzipSync(renderer.source).length;

for (const slug of slugs) {
  const html = readFileSync(join(out, `${slug}.html`), 'utf8');
  const scripts = new Set(
    [...html.matchAll(/<script\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => !/\snomodule\b/i.test(tag))
      .flatMap((tag) => /\ssrc="([^"]+)"/.exec(tag)?.[1] ?? []),
  );
  if ([...scripts].some((src) => join(out, src) === renderer.path)) {
    console.error(`✗ /${slug} renderer is part of initial JS; expected a separate async chunk`);
    process.exit(1);
  }
  let js = 0;
  for (const src of scripts) js += gzipSync(readFileSync(join(out, src))).length;
  rows.push({ what: `/${slug} initial JS (gzipped)`, size: js, budget: BUDGETS.initialJs });
  const entries = canvasEntries(
    out,
    scripts,
    `/_next/static/chunks/${renderer.path.split(/[\\/]/).pop()!}`,
  );
  const async = canvasChunks(out, entries, scripts);
  rows.push({
    what: `/${slug} canvas async JS (gzipped)`,
    size: gzippedChunks(out, async),
    budget: BUDGETS.canvasAsync,
  });
  rows.push({
    what: `/${slug} HTML (raw)`,
    size: Buffer.byteLength(html),
    budget: BUDGETS.cityHtml,
  });
  rows.push({
    what: `/${slug} startup JSON (gzipped)`,
    size: startupJsonSize((suffix) => readFileSync(join(tiles, `${slug}.${suffix}.json`))),
    budget: BUDGETS.startupJson,
  });
  for (const src of scripts) {
    const source = readFileSync(join(out, src), 'utf8');
    if (source.includes('webglcontextlost') || source.includes('#version 300 es'))
      throw new Error(`/${slug} initial chunk contains the renderer: ${src}`);
  }
  notes.push(`/${slug} canvas async chunks: ${[...async].join(', ')}`);
  rows.push({
    what: `/${slug} renderer chunk (gzipped)`,
    size: rendererSize,
    budget: BUDGETS.renderer,
  });
  notes.push(`/${slug} HTML (gzipped): ${human(gzipSync(html).length)}`);

  const pmtiles = join(tiles, `${slug}.pmtiles`);
  const processions = join(tiles, `${slug}.processions.json`);
  const emergency = join(tiles, `${slug}.emergency.json`);
  if (existsSync(emergency))
    rows.push({
      what: `${slug}.emergency.json (gzipped)`,
      size: gzipSync(readFileSync(emergency)).length,
      budget: BUDGETS.emergency,
    });
  if (existsSync(processions))
    rows.push({
      what: `${slug}.processions.json (gzipped)`,
      size: gzipSync(readFileSync(processions)).length,
      budget: BUDGETS.processions,
    });
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

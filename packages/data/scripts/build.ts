import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadCityPacks } from '@atlas/content';
import { step as fetch } from './01-fetch';
import { step as convert } from './02-convert';
import { step as normalize } from './03-normalize';
import { step as mergeContent } from './04-merge-content';
import { step as tiles } from './05-tiles';
import { step as searchIndex } from './06-search-index';
import { cityContext } from './step';

const steps = [fetch, convert, normalize, mergeContent, tiles, searchIndex];

const usage = `Usage: pnpm data:build [-- --city <slug>] [--offline | --refresh] [--from <step>]

  --city <slug>   build one city (default: every registered city)
  --offline       use saved downloads only; fail if one is missing
  --refresh       download OSM data again, replacing the saved copies (otherwise they're kept)
  --from <step>   start at a step, e.g. "03" or "03-normalize" (earlier outputs must exist)`;

const { values } = parseArgs({
  // pnpm forwards a literal "--" separator; drop it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    city: { type: 'string' },
    offline: { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    from: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(usage);
  process.exit(0);
}

if (values.offline && values.refresh) {
  console.error('--offline and --refresh contradict each other; pick one.');
  process.exit(1);
}

const fromIndex = values.from ? steps.findIndex((s) => s.name.startsWith(values.from!)) : 0;
if (fromIndex < 0) {
  console.error(`Unknown step "${values.from}". Steps: ${steps.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const { packs, errors } = await loadCityPacks(undefined, { only: values.city });
if (errors.length > 0) {
  for (const { file, message } of errors) console.error(`✗ ${file}: ${message}`);
  console.error('\nFix the city packs above (pnpm --filter @atlas/content validate).');
  process.exit(1);
}

for (const { city, content } of packs) {
  console.log(`\n■ ${city.slug}`);
  const ctx = cityContext(city, content, values);
  await mkdir(ctx.rawDir, { recursive: true });
  await mkdir(ctx.buildDir, { recursive: true });
  for (const step of steps.slice(fromIndex)) {
    const started = performance.now();
    console.log(`▶ ${step.name}`);
    await step.run(ctx);
    console.log(`  done in ${Math.round(performance.now() - started)} ms`);
  }
}

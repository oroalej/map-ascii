import { step as fetch } from './01-fetch';
import { step as convert } from './02-convert';
import { step as normalize } from './03-normalize';
import { step as mergeContent } from './04-merge-content';
import { step as tiles } from './05-tiles';
import { step as searchIndex } from './06-search-index';

const steps = [fetch, convert, normalize, mergeContent, tiles, searchIndex];

for (const step of steps) {
  const started = performance.now();
  console.log(`▶ ${step.name}`);
  await step.run();
  console.log(`  done in ${Math.round(performance.now() - started)} ms`);
}

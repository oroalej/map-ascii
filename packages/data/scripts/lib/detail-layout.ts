import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DetailLayouts } from '@atlas/shared/schemas';
import { detailLayoutKey } from '@atlas/shared/detail-layout';
import type { StepContext } from '../step';
import { files } from '../step';
import { readJson, writeJson } from './io';
import { sha256 } from './tiles-release';

const layoutKeys = (details: StepContext['content']['details']) =>
  Object.fromEntries(details.map((detail) => [detail.id, detailLayoutKey(detail)]));

const mergeInputKey = ({ city, content }: Pick<StepContext, 'city' | 'content'>) =>
  createHash('sha256').update(JSON.stringify({ city, content })).digest('hex');

/** Bind fingerprints to the successfully written merge, not to a later pack reload. */
export async function writeDetailLayouts(ctx: StepContext): Promise<void> {
  await writeJson(join(ctx.buildDir, files.detailLayouts), {
    inputs: mergeInputKey(ctx),
    merged: sha256(await readFile(join(ctx.buildDir, files.merged))),
    layouts: layoutKeys(ctx.content.details),
  });
}

/** Starting from step 05 may reuse a merge only when its content and bytes still match. */
export async function readDetailLayouts(ctx: StepContext): Promise<Record<string, string>> {
  const stale = () =>
    new Error('Merged content is stale or lacks its layout snapshot; rerun from step 04.');
  let snapshot: { inputs?: unknown; merged?: unknown; layouts?: unknown };
  try {
    snapshot = await readJson(join(ctx.buildDir, files.detailLayouts));
  } catch {
    throw stale();
  }
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    snapshot.inputs !== mergeInputKey(ctx) ||
    snapshot.merged !== sha256(await readFile(join(ctx.buildDir, files.merged))) ||
    JSON.stringify(snapshot.layouts) !== JSON.stringify(layoutKeys(ctx.content.details))
  )
    throw stale();
  return DetailLayouts.parse(snapshot.layouts);
}

/** Keep smoke-only fingerprints separate from metadata loaded by the map. */
export async function publishDetailLayouts(
  { city, outDir }: Pick<StepContext, 'city' | 'outDir'>,
  layouts: unknown,
): Promise<void> {
  await writeJson(join(outDir, `${city.slug}.detail-layouts.json`), DetailLayouts.parse(layouts));
}

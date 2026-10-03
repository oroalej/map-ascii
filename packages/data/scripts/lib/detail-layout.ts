import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SiteDetail } from '@atlas/shared';
import type { StepContext } from '../step';
import { files } from '../step';
import { readJson, writeJson } from './io';
import { sha256 } from './tiles-release';

/** Geometry/selection fingerprint for matching local smoke fixtures to a generated archive. */
export function detailLayoutKey(input: unknown): string {
  const detail = SiteDetail.parse(input);
  // Parsing fixes property order and defaults. Annotation edits do not invalidate a layout.
  const layout = {
    osm_id: detail.osm_id,
    selection_osm_id: detail.selection_osm_id,
    surface: detail.surface,
    grounds: detail.grounds,
    ...(detail.extent && { extent: detail.extent }),
    structures: detail.structures.map((part) => ({
      ...part,
      ground_override: part.ground_override ?? false,
    })),
    ...(detail.roof_overrides.length && { roof_overrides: detail.roof_overrides }),
    ...(detail.building_overrides.length && { building_overrides: detail.building_overrides }),
    flagpoles: detail.flagpoles,
    walks: detail.walks,
    seating: detail.seating,
    lamps: detail.lamps,
    ...(detail.parked_vehicles.length && { parked_vehicles: detail.parked_vehicles }),
  };
  return createHash('sha256').update(JSON.stringify(layout)).digest('hex');
}

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
  return snapshot.layouts as Record<string, string>;
}

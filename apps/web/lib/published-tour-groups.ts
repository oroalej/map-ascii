// Build-time only: validate the sidecar the browser will load before exporting its menu.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { City } from '@atlas/shared';
import { isCityTours } from './guards';

export async function assertPublishedTourGroups(
  city: Pick<City, 'slug' | 'tour_groups'>,
  read: (path: string, encoding: 'utf8') => Promise<string> = readFile,
): Promise<void> {
  const repair = `Regenerate and publish ${city.slug}'s tour sidecar with pnpm data:build -- --city ${city.slug} and pnpm data:publish -- --city ${city.slug}.`;
  let source: string;
  try {
    source = await read(join(process.cwd(), 'public', 'tiles', `${city.slug}.tours.json`), 'utf8');
  } catch (error) {
    // Missing generated data already has a normal notice in CityAtlas.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return;
    throw new Error(`Cannot read published tours for ${city.slug}. ${repair}`, { cause: error });
  }
  const payload: unknown = JSON.parse(source);
  if (!isCityTours(payload)) throw new Error(`Invalid published tours for ${city.slug}. ${repair}`);
  const groups = city.tour_groups && new Set(city.tour_groups.map((group) => group.id));
  for (const tour of payload) {
    if (groups ? tour.group !== undefined && groups.has(tour.group) : tour.group === undefined)
      continue;
    const assignment = tour.group === undefined ? '<missing>' : JSON.stringify(tour.group);
    throw new Error(
      `Published tour ${tour.id} in ${city.slug} has group ${assignment}; expected ${groups ? `one of ${[...groups].join(', ')}` : 'no group'}. ${repair}`,
    );
  }
}

/**
 * Copernicus DEM GLO-90 downloads (DATA.md §1): 1° × 1° Cloud-Optimized GeoTIFFs from the
 * public AWS open-data bucket. Ocean cells have no tile, so a missing one is recorded rather
 * than retried.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BBox } from '@atlas/shared';

const bucket = 'https://copernicus-dem-90m.s3.amazonaws.com';

/** Credit the Copernicus DEM licence asks for, shown with the map (DATA.md §6). */
export const DEM_ATTRIBUTION =
  'Copernicus DEM GLO-90 © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA';

const pad = (n: number, width: number) => String(Math.abs(n)).padStart(width, '0');

/** The GLO-90 tile name for the 1° cell whose south-west corner is (lng, lat). */
export function demTileName(lng: number, lat: number): string {
  const ns = `${lat < 0 ? 'S' : 'N'}${pad(lat, 2)}_00`;
  const ew = `${lng < 0 ? 'W' : 'E'}${pad(lng, 3)}_00`;
  return `Copernicus_DSM_COG_30_${ns}_${ew}_DEM`;
}

/** The 1° cells (south-west corners) that cover a bbox. */
export function demCells([west, south, east, north]: BBox): [number, number][] {
  const cells: [number, number][] = [];
  for (let lat = Math.floor(south); lat < north; lat++) {
    for (let lng = Math.floor(west); lng < east; lng++) cells.push([lng, lat]);
  }
  return cells;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Copy `file` from the first of `copies` that has it; whether one did. */
async function copyFirst(file: string, copies: readonly string[]): Promise<boolean> {
  for (const copy of copies) {
    if (!(await exists(copy))) continue;
    await copyFile(copy, file);
    return true;
  }
  return false;
}

/**
 * Download the DEM tiles covering `bbox` into `dir` (once; the DEM doesn't change). Returns the
 * paths of the tiles that exist. A tile the bucket lacks (open ocean) leaves a `.missing` marker.
 * Another checkout's tile or marker (`copies`, see `copiesElsewhere`) is copied in first.
 */
export async function downloadDem(
  bbox: BBox,
  dir: string,
  { offline, copies = () => [] }: { offline: boolean; copies?: (file: string) => string[] },
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const found: string[] = [];
  for (const [lng, lat] of demCells(bbox)) {
    const name = demTileName(lng, lat);
    const file = join(dir, `${name}.tif`);
    const missing = join(dir, `${name}.missing`);
    if (!(await exists(file)) && !(await exists(missing))) {
      // The DEM never changes, so any saved copy is as good as a download.
      if (!(await copyFirst(file, copies(file)))) await copyFirst(missing, copies(missing));
    }
    if (await exists(file)) {
      found.push(file);
      continue;
    }
    if (await exists(missing)) continue;
    if (offline) throw new Error(`--offline: no cached DEM tile at ${file}`);
    console.log(`  downloading DEM ${name}…`);
    const response = await fetch(`${bucket}/${name}/${name}.tif`);
    if (response.status === 403 || response.status === 404) {
      await writeFile(missing, '');
      continue;
    }
    if (!response.ok) throw new Error(`DEM ${name}: HTTP ${response.status}`);
    await writeFile(file, new Uint8Array(await response.arrayBuffer()));
    found.push(file);
  }
  return found;
}

/** Read a cached file into an ArrayBuffer (geotiff's input). */
export async function readArrayBuffer(path: string): Promise<ArrayBuffer> {
  const bytes = await readFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

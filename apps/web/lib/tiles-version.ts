// Build-time only: never import this module from a client component.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { CityPack } from '@atlas/content';

/** Local pipeline output may differ from the pin; only matching bytes get an immutable URL. */
export async function tilesVersion(
  pack: {
    city: Pick<CityPack['city'], 'slug'>;
    tilesLock?: Pick<NonNullable<CityPack['tilesLock']>, 'files'> | undefined;
  },
  directory = resolve(process.cwd(), 'public/tiles'),
): Promise<string | undefined> {
  const filename = `${pack.city.slug}.pmtiles`;
  const locked = pack.tilesLock?.files[filename];
  if (!locked) return undefined;
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(resolve(directory, filename)))
      hash.update(chunk as Buffer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return hash.digest('hex') === locked ? locked.slice(0, 8) : undefined;
}

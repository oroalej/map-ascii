/** Shared by the e2e specs: the registered cities, and checks that the map is drawing. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  RuntimeCityLifeSchema,
  Procession as ProcessionSchema,
  CityProcessions,
  type SearchIndexFile,
  type CityLifeConfig,
} from '@atlas/shared';
import { expect, type Locator, type Page } from '@playwright/test';

/** Every registered city pack (ARCHITECTURE.md §9: the suite covers each one). */
const citiesDir = new URL('../../../packages/content/cities/', import.meta.url);
export const cities = readdirSync(citiesDir)
  .filter((slug) => existsSync(new URL(`${slug}/city.json`, citiesDir)))
  .sort()
  .map((slug) => {
    const city = JSON.parse(readFileSync(new URL(`${slug}/city.json`, citiesDir), 'utf8')) as {
      name: { en: string };
      smoke_landmark: string;
      life?: CityLifeConfig;
      timezone?: string;
    };
    const hasMeta = existsSync(new URL(`../public/tiles/${slug}.meta.json`, import.meta.url));
    // Use the configured smoke landmark instead of assuming the city's focus is pickable.
    const search = hasMeta
      ? (JSON.parse(
          readFileSync(
            new URL(`../public/tiles/${slug}.search-index.json`, import.meta.url),
            'utf8',
          ),
        ) as SearchIndexFile)
      : null;
    const smokePlace = search?.entries.find(
      (entry) =>
        entry.type === 'landmark' &&
        (entry.name === city.smoke_landmark || entry.altNames.includes(city.smoke_landmark)),
    );
    if (hasMeta && !smokePlace) {
      throw new Error(`${slug}: no landmark search entry for "${city.smoke_landmark}"`);
    }
    const toursDir = new URL(`${slug}/tours/`, citiesDir);
    const runtimeLife = city.life ? RuntimeCityLifeSchema.parse(city.life) : undefined;
    const cemeteryDir = new URL(`${slug}/cemeteries/`, citiesDir);
    const cemeteryIds = existsSync(cemeteryDir)
      ? readdirSync(cemeteryDir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map(
            (f) =>
              (JSON.parse(readFileSync(new URL(f, cemeteryDir), 'utf8')) as { osm_id: string })
                .osm_id,
          )
      : [];
    const cemeteryAnchor = cemeteryIds.flatMap(
      (id) => search?.entries.filter((e) => e.id === id) ?? [],
    )[0];
    if (runtimeLife?.folklore && hasMeta && !cemeteryAnchor)
      throw new Error(`${slug}: folklore needs a mapped cemetery smoke anchor`);
    const eventDir = new URL(`${slug}/processions/`, citiesDir);
    const processions = existsSync(eventDir)
      ? readdirSync(eventDir)
          .filter((file) => file.endsWith('.json'))
          .map((file) =>
            ProcessionSchema.parse(JSON.parse(readFileSync(new URL(file, eventDir), 'utf8'))),
          )
      : [];
    const generatedEventsFile = new URL(
      `../public/tiles/${slug}.processions.json`,
      import.meta.url,
    );
    const generatedProcessions = existsSync(generatedEventsFile)
      ? CityProcessions.parse(JSON.parse(readFileSync(generatedEventsFile, 'utf8'))).processions
      : [];
    const tours = existsSync(toursDir)
      ? readdirSync(toursDir)
          .filter((file) => file.endsWith('.json'))
          .sort()
          .map((file) => JSON.parse(readFileSync(new URL(file, toursDir), 'utf8')) as TourFile)
      : [];
    return {
      slug,
      folklore: !!runtimeLife?.folklore,
      timezone: city.timezone,
      cemeteryAnchor,
      name: city.name.en,
      smokeLandmark: city.smoke_landmark,
      smokePlace,
      hasMeta,
      tours,
      processions,
      generatedProcessions,
      seasons: city.life ? (RuntimeCityLifeSchema.parse(city.life).seasons ?? []) : [],
    };
  });

/** The parts of a city pack's tour file the tests read. */
export type TourFile = {
  id: string;
  title: { en: string };
  steps: { narration: { en: string }; duration_ms: number }[];
};

/**
 * A screenshot of the map alone: the HUD, search, panels, and attribution are hidden while it is
 * taken, so their text can't pass for drawn glyphs.
 */
export const mapShot = (canvas: Locator) =>
  canvas.screenshot({ style: 'main > :not(canvas) { visibility: hidden !important; }' });

/**
 * Share of pixels in a PNG screenshot that differ from the page background. The PNG is decoded
 * in the page, which avoids an image dependency here.
 */
export async function drawnShare(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const ctx = Object.assign(document.createElement('canvas'), {
        width: image.width,
        height: image.height,
      }).getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);
      let drawn = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
        if (Math.abs(r - 4) + Math.abs(g - 5) + Math.abs(b - 10) > 24) drawn++;
      }
      return drawn / (data.length / 4);
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}

/**
 * Share of the canvas that must be ink once tiles load. Glyph strokes are thin, more so on
 * high-DPR phones (~2% of pixels at the default camera), so this only proves drawing happened.
 */
export const MIN_DRAWN = 0.01;

/** Wait until the atlas is live (the HUD shows its zoom), so keyboard input reaches the map. */
export async function mapReady(page: Page) {
  await expect(page.getByLabel('Zoom')).toHaveText(/^z \d/, { timeout: 20_000 });
}

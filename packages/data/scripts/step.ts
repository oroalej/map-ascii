import { fileURLToPath } from 'node:url';

/** Absolute paths shared by pipeline steps. */
export const paths = {
  raw: fileURLToPath(new URL('../raw/', import.meta.url)),
  build: fileURLToPath(new URL('../build/', import.meta.url)),
  webTiles: fileURLToPath(new URL('../../../apps/web/public/tiles/', import.meta.url)),
};

export type Step = {
  name: string;
  run: () => Promise<void>;
};

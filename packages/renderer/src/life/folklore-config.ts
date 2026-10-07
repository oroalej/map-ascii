import type { FolkloreConfig, RuntimeCityLife, SeasonWindow } from '@atlas/shared';

export type RuntimeFolklore = Omit<FolkloreConfig, 'sources'> & { undasWindow: SeasonWindow };

/** Windows stay out of the existing physical/emoji seasonal projection. */
export function runtimeFolklore(life: RuntimeCityLife | undefined): RuntimeFolklore | undefined {
  const config = life?.folklore;
  if (!config) return;
  const undasWindow = life.seasons?.find(
    (season) => season.id === config.ghosts.undas_season,
  )?.window;
  if (!undasWindow) return;
  const { hours, ghosts, manananggal } = config;
  return { hours, ghosts, manananggal, undasWindow };
}

export const FOLKLORE = {
  seed: 0x5f356495,
  hauntCount: 8,
  hauntRadius: 8,
  hauntFrequency: 2,
  hauntDim: 0.35,
  hauntBright: 1,
  ghostSpeed: [0.3, 0.5] as const,
  relocation: [40, 90] as const,
  fieldToCentre: 300,
  roofRadius: 150,
  roofMinimum: 3,
  orbitRadius: [60, 150] as const,
  flight: [180, 360] as const,
  landing: [30, 90] as const,
  approach: 12,
  departure: 12,
  returnMinutes: 30,
  dogRadius: 25,
  flockRadius: 20,
} as const;

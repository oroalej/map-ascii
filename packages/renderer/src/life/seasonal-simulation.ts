import type { SeasonConfig } from '@atlas/shared';

/** Immutable, simulation-only calendar table installed once per Atlas instance. */
export type SimulationSeason = {
  id: string;
  stalls?: Pick<NonNullable<SeasonConfig['stalls']>, 'near' | 'radius_m' | 'per_tile'>;
  installations?: readonly { id: string; anchor: string; kind: 'christmas-tree' }[];
};

export function simulationSeasons(seasons: readonly SeasonConfig[] = []): SimulationSeason[] {
  return seasons.flatMap(({ id, stalls, installations }) => {
    const trees = installations
      ?.filter((i) => i.kind === 'christmas-tree')
      .map(({ id, anchor }) => ({ id, anchor, kind: 'christmas-tree' as const }));
    if (!stalls && !trees?.length) return [];
    return [
      {
        id,
        ...(stalls && {
          stalls: { near: stalls.near, radius_m: stalls.radius_m, per_tile: stalls.per_tile },
        }),
        ...(trees?.length && { installations: trees }),
      },
    ];
  });
}

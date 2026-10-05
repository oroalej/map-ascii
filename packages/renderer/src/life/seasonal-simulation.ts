import type { RuntimeSeasonConfig } from '@atlas/shared';

/** Immutable, simulation-only calendar table installed once per Atlas instance. */
export type SimulationSeason = {
  id: string;
  includes?: readonly string[];
  stalls?: Pick<NonNullable<RuntimeSeasonConfig['stalls']>, 'near' | 'radius_m' | 'per_tile'>;
  installations?: readonly { id: string; anchor: string; kind: 'christmas-tree' | 'carnival' }[];
};

export function simulationSeasons(
  seasons: readonly RuntimeSeasonConfig[] = [],
): SimulationSeason[] {
  return seasons.flatMap(({ id, includes, stalls, installations }) => {
    const trees = installations?.flatMap((i) =>
      i.kind === 'christmas-tree' || i.kind === 'carnival'
        ? [{ id: i.id, anchor: i.anchor, kind: i.kind }]
        : [],
    );
    if (!stalls && !trees?.length) return [];
    return [
      {
        id,
        ...(includes && { includes }),
        ...(stalls && {
          stalls: { near: stalls.near, radius_m: stalls.radius_m, per_tile: stalls.per_tile },
        }),
        ...(trees?.length && { installations: trees }),
      },
    ];
  });
}

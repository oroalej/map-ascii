/** Bake selected seasonal corridors before tiling; no city geography lives in the renderer. */
import {
  utilitySeed,
  type BuntingCorridor,
  type SeasonConfig,
  type SeasonalPoint,
  type SeasonalBuntingRecord,
} from '@atlas/shared';
import type { AtlasFeature } from '../03-normalize';
import { lines } from './road-geometry';
import { roadGraph } from './road-graph';
const pointKey = (p: SeasonalPoint) => `${p[0].toFixed(7)}/${p[1].toFixed(7)}`;

function bakeCorridor(features: readonly AtlasFeature[], season: string, config: BuntingCorridor) {
  if (!Number.isFinite(config.spacing_m) || config.spacing_m < 3 || config.spacing_m > 80)
    throw new Error(`Season ${season}, corridor ${config.id}: invalid spacing`);
  const byId = new Map(
    features.filter((f) => !f.properties.region).map((f) => [f.properties.id, f]),
  );
  const roads = config.ways.map((id) => {
    const f = byId.get(id);
    if (!f || !f.properties.class.startsWith('road_') || !lines(f).length)
      throw new Error(`Season ${season}, corridor ${config.id}: missing road ${id}`);
    return f;
  });
  const { selected, dist, unproject } = roadGraph(
    byId,
    roads,
    config,
    `Season ${season}, corridor ${config.id}`,
  );
  const records = new Map<string, SeasonalBuntingRecord>();
  for (const e of selected.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const a = dist.get(e.a)! <= dist.get(e.b)! ? e.a : e.b,
      b = a === e.a ? e.b : e.a;
    const start = dist.get(a)!,
      nx = -(b.xy[1] - a.xy[1]) / e.length,
      ny = (b.xy[0] - a.xy[0]) / e.length;
    for (
      let d = Math.ceil((start - 1e-7) / config.spacing_m) * config.spacing_m;
      d < start + e.length - 1e-7;
      d += config.spacing_m
    ) {
      const u = Math.max(0, (d - start) / e.length),
        x = a.xy[0] + (b.xy[0] - a.xy[0]) * u,
        y = a.xy[1] + (b.xy[1] - a.xy[1]) * u;
      const at = unproject([x, y]),
        id = `season:${season}/${config.id}/${pointKey(at)}`;
      const reach = e.width / 2 + 0.5;
      records.set(id, {
        version: 1,
        kind: 'bunting',
        id,
        season,
        corridor: config.id,
        road: e.road,
        from: unproject([x - nx * reach, y - ny * reach]),
        to: unproject([x + nx * reach, y + ny * reach]),
        segment: [a.at, b.at],
        seed: utilitySeed(id),
      });
      if (records.size > 20000)
        throw new Error(`Season ${season}, corridor ${config.id}: too many rows`);
    }
  }
  if (!records.size) throw new Error(`Season ${season}, corridor ${config.id}: no bunting rows`);
  return { records: [...records.values()], meters: selected.reduce((n, e) => n + e.length, 0) };
}

export function generateSeasonalBunting(
  features: readonly AtlasFeature[],
  seasons?: readonly SeasonConfig[],
) {
  const records: SeasonalBuntingRecord[] = [],
    stats: { season: string; corridor: string; ways: number; meters: number; rows: number }[] = [];
  for (const season of seasons ?? [])
    for (const corridor of season.bunting?.corridors ?? []) {
      const baked = bakeCorridor(features, season.id, corridor);
      records.push(...baked.records);
      stats.push({
        season: season.id,
        corridor: corridor.id,
        ways: corridor.ways.length,
        meters: Math.round(baked.meters),
        rows: baked.records.length,
      });
    }
  records.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw new Error('Duplicate seasonal row identities');
  return { records, stats };
}

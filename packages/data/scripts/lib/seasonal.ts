/** Bake selected seasonal corridors before tiling; no city geography lives in the renderer. */
import {
  utilitySeed,
  type BuntingCorridor,
  type SeasonConfig,
  type SeasonalPoint,
  type SeasonalBuntingRunRecord,
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
  const { selected, dist } = roadGraph(
    byId,
    roads,
    config,
    `Season ${season}, corridor ${config.id}`,
  );
  // One run per edge: decoding expands its evenly spaced curb-to-curb rows.
  const records = new Map<string, SeasonalBuntingRunRecord>();
  // Branches leaving one node would each hang a row on it; the first edge keeps it.
  const nodeRows = new Set<string>();
  let rows = 0;
  for (const e of selected.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const a = dist.get(e.a)! <= dist.get(e.b)! ? e.a : e.b,
      b = a === e.a ? e.b : e.a;
    const start = dist.get(a)!;
    let first = Math.ceil((start - 1e-7) / config.spacing_m) * config.spacing_m;
    if (Math.abs(first - start) <= 1e-7) {
      if (nodeRows.has(a.key)) first += config.spacing_m;
      else nodeRows.add(a.key);
    }
    const count = Math.max(0, Math.ceil((start + e.length - 1e-7 - first) / config.spacing_m));
    if (!count) continue;
    const id = `season:${season}/${config.id}/${pointKey(a.at)}/${pointKey(b.at)}`;
    records.set(id, {
      version: 1,
      kind: 'bunting-run',
      id,
      season,
      corridor: config.id,
      road: e.road,
      segment: [a.at, b.at],
      start_m: Math.round(Math.max(0, first - start) * 1000) / 1000,
      spacing_m: config.spacing_m,
      count,
      reach_m: e.width / 2 + 0.5,
      seed: utilitySeed(id),
    });
    rows += count;
    if (rows > 20000) throw new Error(`Season ${season}, corridor ${config.id}: too many rows`);
  }
  if (!records.size) throw new Error(`Season ${season}, corridor ${config.id}: no bunting rows`);
  return {
    records: [...records.values()],
    rows,
    meters: selected.reduce((n, e) => n + e.length, 0),
  };
}

export function generateSeasonalBunting(
  features: readonly AtlasFeature[],
  seasons?: readonly SeasonConfig[],
) {
  const records: SeasonalBuntingRunRecord[] = [],
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
        rows: baked.rows,
      });
    }
  records.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw new Error('Duplicate seasonal row identities');
  return { records, stats };
}

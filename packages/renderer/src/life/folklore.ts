import { seasonContains } from '@atlas/shared';
import { lngLatToTile, tileToLngLat } from '../raster/geometry';
import { FOLKLORE, type RuntimeFolklore } from './folklore-config';
import {
  FolkloreGeometry,
  distance,
  mixPoint,
  type Candidate,
  type FolkloreTile,
  type Point,
  type RoofAnchor,
  type Site,
} from './folklore-geometry';
import { manananggalPose, manananggalTiming } from './manananggal';
import { between, hashString, random } from './random';
import { LIFE_ZOOM } from './config';

export type FolkloreCalendar = { epochDay: number; preview?: string };
export type FolkloreSprite = {
  id: string;
  kind: 'ghost' | 'manananggal' | 'lower-half';
  lng: number;
  lat: number;
  heading: number;
  pose: 'breath' | 'wisp' | 'flying' | 'perched' | 'lower';
  alpha: number;
  phase: number;
  wisp: number;
};
export type HauntPoint = { id: string; lng: number; lat: number; radius: number };
export type FolklorePacket = { sprites: readonly FolkloreSprite[]; haunts: readonly HauntPoint[] };
export const EMPTY_FOLKLORE: FolklorePacket = { sprites: [], haunts: [] };
export type FolkloreBody = Point & {
  hx: number;
  hy: number;
  length: number;
  width: number;
  walker: boolean;
};
export type FolkloreEnvironment = {
  minutes?: number;
  calendar?: FolkloreCalendar;
  clock: number;
  dt: number;
  pointer?: { lngLat: readonly [number, number]; reachM: number };
};
type Ghost = {
  id: string;
  site: Site;
  index: number;
  seed: number;
  born: number;
  period: number;
  speed: number;
  range: number;
  route: Point[];
  routeLength: number;
  breathPeriod: number;
  fadeDuration: number;
  cycle: number;
  path?: { start: Point; end: Point };
  alphaNear: number;
  overlap: boolean;
  wispAt: number;
};
type Selection = { candidate: Candidate; born: number; cycle: number; landing: RoofAnchor };
// Mix sequential dates before sampling: raw FNV ratios cluster across neighboring days.
const unitHash = (value: string) => random(hashString(value) ^ FOLKLORE.seed)();
const clamp = (v: number) => Math.max(0, Math.min(1, v));

export function folkloreNight(
  config: RuntimeFolklore,
  calendar: FolkloreCalendar | undefined,
  minutes: number | undefined,
) {
  if (!calendar || minutes === undefined || !Number.isFinite(minutes)) return;
  const { from, to } = config.hours,
    wrap = from > to;
  if (wrap ? minutes < from && minutes >= to : minutes < from || minutes >= to) return;
  const day = calendar.epochDay - (wrap && minutes < to ? 1 : 0),
    year = new Date(day * 86_400_000).getUTCFullYear();
  const undas =
    calendar.preview === config.ghosts.undas_season ||
    seasonContains(config.undasWindow, year, day);
  const end = wrap ? to + 1440 : to,
    minute = wrap && minutes < to ? minutes + 1440 : minutes;
  return {
    day,
    year,
    undas,
    remaining: end - minute,
    manananggal:
      ((undas && calendar.preview === config.ghosts.undas_season) ||
        seasonContains(config.manananggal.window, year, day)) &&
      unitHash(`manananggal/${day}`) < config.manananggal.night_chance,
  };
}
export function ghostCount(
  config: RuntimeFolklore,
  site: Pick<Site, 'id' | 'kind'>,
  night: NonNullable<ReturnType<typeof folkloreNight>>,
) {
  if (!config.ghosts.sites.includes(site.kind)) return 0;
  if (site.kind !== 'cemetery')
    return unitHash(`${site.kind}/${site.id}/${night.day}`) < config.ghosts.site_share ? 1 : 0;
  const [low, high] = night.undas ? config.ghosts.undas_per_cemetery : config.ghosts.per_cemetery;
  return low + Math.floor(unitHash(`cemetery/${site.id}/${night.day}`) * (high - low + 1));
}
export const folkloreMinimumZoom = (sprite: Pick<FolkloreSprite, 'kind'>) =>
  sprite.kind === 'ghost' ? LIFE_ZOOM.person.min : 15;
function routePoint(route: readonly Point[], travel: number): Point {
  for (let i = 0; i + 1 < route.length; i++) {
    const length = distance(route[i]!, route[i + 1]!);
    if (travel <= length) return mixPoint(route[i]!, route[i + 1]!, length ? travel / length : 0);
    travel -= length;
  }
  return route.at(-1)!;
}
const routeLength = (route: readonly Point[]) =>
  route.slice(1).reduce((sum, point, i) => sum + distance(route[i]!, point), 0);

/** Independent observer state. It never receives mutable physical owners or their RNGs. */
export class FolkloreObserver {
  private config: RuntimeFolklore | undefined;
  private geometry: FolkloreGeometry | undefined;
  private ref: Pick<FolkloreTile, 'tile' | 'perMeter'> | undefined;
  private ghosts = new Map<string, Ghost>();
  private tileSeeds = new Map<string, number>();
  private nightKey = '';
  private selection: Selection | undefined;
  private sprites: FolkloreSprite[] = [];
  private creature: FolkloreSprite | undefined;
  private cursorShift: Point = { x: 0, y: 0 };
  constructor(private readonly enabled = true) {}
  get configured() {
    return this.enabled && this.config !== undefined;
  }
  get manananggal() {
    return this.creature;
  }
  setConfig(config: RuntimeFolklore | undefined) {
    this.config = config;
    this.clear();
  }
  clear() {
    this.cursorShift = { x: 0, y: 0 };
    this.geometry = undefined;
    this.ref = undefined;
    this.ghosts.clear();
    this.tileSeeds.clear();
    this.nightKey = '';
    this.selection = undefined;
    this.sprites = [];
    this.creature = undefined;
  }
  private landing(geometry: FolkloreGeometry, candidate: Candidate, night: number, cycle: number) {
    return geometry
      .roofsNear(candidate.centre.at, FOLKLORE.roofRadius)
      .map((roof) => ({ roof, rank: unitHash(`${roof.id}/${night}/${cycle}`) }))
      .sort((a, b) => a.rank - b.rank || a.roof.id.localeCompare(b.roof.id))[0]?.roof;
  }
  step(
    tiles: readonly FolkloreTile[],
    env: FolkloreEnvironment,
    bodies: (
      geometry: FolkloreGeometry,
      ghosts: readonly Point[],
    ) => readonly FolkloreBody[] = () => [],
  ) {
    const config = this.config,
      night = config && folkloreNight(config, env.calendar, env.minutes);
    this.sprites = [];
    this.creature = undefined;
    if (!this.enabled || !config || !night || !tiles.length) {
      this.geometry = undefined;
      this.ghosts.clear();
      this.selection = undefined;
      this.nightKey = '';
      if (!tiles.length) {
        this.ref = undefined;
        this.tileSeeds.clear();
      }
      return;
    }
    const key = `${night.day}/${night.undas}/${env.calendar?.preview ?? ''}`;
    if (key !== this.nightKey) {
      this.ghosts.clear();
      this.selection = undefined;
      this.nightKey = key;
    }
    const ordered = [...tiles].sort((a, b) => a.key.localeCompare(b.key));
    this.ref ??= { tile: ordered[0]!.tile, perMeter: ordered[0]!.perMeter };
    const changed =
      !this.geometry ||
      ordered.length !== this.geometry.sources.length ||
      ordered.some(
        (t, i) =>
          t.key !== this.geometry!.sources[i]!.key || t.geo !== this.geometry!.sources[i]!.geo,
      );
    if (changed) {
      this.geometry = new FolkloreGeometry(ordered, this.ref);
    }
    const geometry = this.geometry!;
    const pointer = env.pointer && lngLatToTile(this.ref.tile, ...env.pointer.lngLat);
    if (pointer) {
      pointer.x /= this.ref.perMeter;
      pointer.y /= this.ref.perMeter;
    } else this.cursorShift = { x: 0, y: 0 };
    for (const tile of ordered)
      if (!this.tileSeeds.has(tile.key))
        this.tileSeeds.set(
          tile.key,
          Math.floor(random(hashString(tile.key) ^ FOLKLORE.seed)() * 0x100000000),
        );
    const activeSeeds = new Set(ordered.map((t) => t.key));
    for (const key of this.tileSeeds.keys()) if (!activeSeeds.has(key)) this.tileSeeds.delete(key);
    if (
      this.selection &&
      (!night.manananggal ||
        !geometry.admitsField(this.selection.candidate.id, this.selection.candidate.lower) ||
        !geometry.admitsRoof(
          this.selection.candidate.centre.id,
          this.selection.candidate.centre.at,
        ) ||
        !geometry.admitsRoof(this.selection.landing.id, this.selection.landing.at))
    )
      this.selection = undefined;
    if (night.manananggal && !this.selection) {
      const farmland = geometry.candidates.filter((c) => c.kind === 'farmland');
      const candidate = (farmland.length ? farmland : geometry.candidates)
        .map((candidate) => ({ candidate, rank: unitHash(`${candidate.id}/${night.day}`) }))
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.candidate.id.localeCompare(b.candidate.id) ||
            a.candidate.lower.x - b.candidate.lower.x ||
            a.candidate.lower.y - b.candidate.lower.y,
        )[0]?.candidate;
      const landing = candidate && this.landing(geometry, candidate, night.day, 0);
      if (candidate && landing)
        this.selection = {
          candidate,
          born: env.clock,
          cycle: 0,
          landing: { ...landing, at: { ...landing.at } },
        };
    }
    if (this.selection) {
      const selected = this.selection,
        elapsed = env.clock - selected.born;
      const cycle = Math.floor(elapsed / manananggalTiming(selected.candidate, night.day).span);
      if (cycle !== selected.cycle) {
        const landing = this.landing(geometry, selected.candidate, night.day, cycle);
        if (landing) {
          selected.cycle = cycle;
          selected.landing = { ...landing, at: { ...landing.at } };
        } else this.selection = undefined;
      }
      if (this.selection) {
        const pose = manananggalPose(
          selected.candidate,
          selected.landing,
          night.day,
          elapsed,
          night.remaining,
        );
        if (pointer) {
          const dx = pose.at.x - pointer.x,
            dy = pose.at.y - pointer.y;
          const distance = Math.hypot(dx, dy),
            reach = env.pointer!.reachM;
          const close = distance < reach;
          const strength = close ? Math.min(8, reach * 0.5) * (1 - distance / reach) : 0;
          const k = 1 - Math.exp(-Math.max(0, env.dt) / (close ? 0.3 : 0.6));
          const x = distance > 1e-9 ? dx / distance : Math.cos(pose.heading),
            y = distance > 1e-9 ? dy / distance : Math.sin(pose.heading);
          this.cursorShift.x += (x * strength - this.cursorShift.x) * k;
          this.cursorShift.y += (y * strength - this.cursorShift.y) * k;
          if (Math.hypot(this.cursorShift.x, this.cursorShift.y) < 1e-5)
            this.cursorShift = { x: 0, y: 0 };
          if (this.cursorShift.x || this.cursorShift.y)
            pose.at = { x: pose.at.x + this.cursorShift.x, y: pose.at.y + this.cursorShift.y };
        }
        if (!pose.returned) {
          const alpha = clamp(elapsed / 4) * clamp((night.remaining * 60) / 6);
          const [lng, lat] = tileToLngLat(this.ref.tile, {
            x: pose.at.x * this.ref.perMeter,
            y: pose.at.y * this.ref.perMeter,
          });
          const id = `manananggal/${night.day}/${selected.candidate.id}`;
          this.creature = {
            id,
            kind: 'manananggal',
            lng,
            lat,
            heading: pose.heading,
            pose: pose.pose,
            alpha,
            phase: pose.flap,
            wisp: 0,
          };
          const lower = tileToLngLat(this.ref.tile, {
            x: selected.candidate.lower.x * this.ref.perMeter,
            y: selected.candidate.lower.y * this.ref.perMeter,
          });
          this.sprites.push(this.creature, {
            id: `${id}/lower`,
            kind: 'lower-half',
            lng: lower[0],
            lat: lower[1],
            heading: 0,
            pose: 'lower',
            alpha,
            phase: 0,
            wisp: 0,
          });
        }
      }
    }
    const keep = new Set<string>(),
      samples: { ghost: Ghost; at: Point; elapsed: number; age: number; site: Site; id: string }[] =
        [];
    for (const site of geometry.sites) {
      const count = ghostCount(config, site, night);
      for (let index = 0; index < count; index++) {
        const id = `ghost/${site.kind}/${site.id}/${night.day}/${index}`;
        keep.add(id);
        let ghost = this.ghosts.get(id);
        if (!ghost) {
          const source =
              site.fragments?.[index % (site.fragments.length || 1)]?.source ?? ordered[0]!,
            seed = hashString(id) ^ this.tileSeeds.get(source.key)!;
          const rng = random(seed);
          const route = site.kind === 'cemetery' ? [] : geometry.route(site);
          ghost = {
            id,
            site,
            index,
            seed,
            born: env.clock,
            period: between(rng, FOLKLORE.relocation),
            speed: between(rng, FOLKLORE.ghostSpeed),
            range: between(rng, config.ghosts.range_m),
            route,
            routeLength: routeLength(route),
            breathPeriod: 3 + unitHash(id) * 2,
            fadeDuration: 3 + unitHash(`${id}/fade`) * 3,
            cycle: -1,
            alphaNear: 1,
            overlap: false,
            wispAt: -Infinity,
          };
          this.ghosts.set(id, ghost);
        }
        if (changed) {
          ghost.site = site;
          ghost.cycle = -1;
          if (site.kind !== 'cemetery') {
            ghost.route = geometry.route(site);
            ghost.routeLength = routeLength(ghost.route);
          }
        }
        const elapsed = env.clock - ghost.born,
          cycle = Math.floor(elapsed / ghost.period),
          age = elapsed - cycle * ghost.period;
        let at: Point;
        if (site.kind === 'cemetery') {
          const fragments = site.fragments!;
          if (cycle !== ghost.cycle) {
            ghost.cycle = cycle;
            ghost.path = undefined;
            for (let n = 0; n < fragments.length; n++) {
              const fragment = fragments[(index + n) % fragments.length]!;
              const path = geometry.cemeteryPath(
                fragment,
                ghost.seed ^ hashString(`${cycle}`),
                ghost.speed * Math.max(0, ghost.period - 2),
              );
              if (path) {
                ghost.path = path;
                break;
              }
            }
          }
          if (!ghost.path) continue;
          at = mixPoint(
            ghost.path.start,
            ghost.path.end,
            clamp(age / Math.max(1, ghost.period - 2)),
          );
        } else {
          const range = Math.min(ghost.routeLength, ghost.range);
          const progress = range ? (elapsed * ghost.speed) % (range * 2) : 0;
          at = routePoint(ghost.route, progress <= range ? progress : range * 2 - progress);
        }
        samples.push({ ghost, at, elapsed, age, site, id });
      }
    }
    for (const id of this.ghosts.keys()) if (!keep.has(id)) this.ghosts.delete(id);
    // Current admission must precede observations, including the first step of a new night.
    const observations = samples.length
      ? bodies(
          geometry,
          samples.map((sample) => sample.at),
        )
      : [];
    for (const { ghost, at, elapsed, age, site, id } of samples) {
      const cursorDistance = pointer ? Math.hypot(at.x - pointer.x, at.y - pointer.y) : Infinity;
      let near = cursorDistance < (env.pointer?.reachM ?? 0),
        overlap = cursorDistance < (env.pointer?.reachM ?? 0) * 0.15;
      for (const body of observations) {
        const dx = at.x - body.x,
          dy = at.y - body.y;
        if (body.walker && Math.hypot(dx, dy) < 3) near = true;
        if (
          Math.abs(dx * body.hx + dy * body.hy) < body.length / 2 + 0.35 &&
          Math.abs(-dx * body.hy + dy * body.hx) < body.width / 2 + 0.35
        )
          overlap = true;
      }
      if (overlap && !ghost.overlap) ghost.wispAt = env.clock;
      ghost.overlap = overlap;
      ghost.alphaNear = near ? 0 : Math.min(1, ghost.alphaNear + Math.max(0, env.dt) / 2);
      const breath = 0.55 + 0.2 * Math.sin((elapsed * Math.PI * 2) / ghost.breathPeriod);
      const fade =
        clamp(elapsed / ghost.fadeDuration) *
        clamp((night.remaining * 60) / 6) *
        (site.kind === 'cemetery' ? Math.min(clamp(age / 2), clamp((ghost.period - age) / 2)) : 1);
      const alpha = (0.15 + (breath - 0.15) * ghost.alphaNear) * fade,
        wispAge = env.clock - ghost.wispAt,
        wisp = wispAge >= 0 && wispAge < 0.8 ? wispAge / 0.8 : 0;
      const [lng, lat] = tileToLngLat(this.ref.tile, {
        x: at.x * this.ref.perMeter,
        y: at.y * this.ref.perMeter,
      });
      this.sprites.push({
        id,
        kind: 'ghost',
        lng,
        lat,
        heading: 0,
        pose: wispAge >= 0 && wispAge < 0.8 ? 'wisp' : 'breath',
        alpha,
        phase: Math.sin(elapsed * 2),
        wisp,
      });
    }
  }
  packet(zoom: number, center: readonly [number, number]): FolklorePacket {
    if (!this.ref) return EMPTY_FOLKLORE;
    const sprites = this.sprites.filter((s) => zoom >= folkloreMinimumZoom(s) && s.alpha > 0.001);
    const origin = lngLatToTile(this.ref.tile, center[0], center[1]);
    const metres = { x: origin.x / this.ref.perMeter, y: origin.y / this.ref.perMeter };
    const ghosts = sprites
      .filter((s) => s.kind === 'ghost')
      .map((s) => {
        const p = lngLatToTile(this.ref!.tile, s.lng, s.lat);
        return {
          sprite: s,
          distance: distance(metres, { x: p.x / this.ref!.perMeter, y: p.y / this.ref!.perMeter }),
        };
      })
      .sort((a, b) => a.distance - b.distance || a.sprite.id.localeCompare(b.sprite.id));
    const creature = sprites.find((s) => s.kind === 'manananggal'),
      haunted = [
        ...(creature ? [creature] : []),
        ...ghosts.slice(0, FOLKLORE.hauntCount - (creature ? 1 : 0)).map((g) => g.sprite),
      ];
    return {
      sprites,
      haunts: haunted.map((s) => ({
        id: s.id,
        lng: s.lng,
        lat: s.lat,
        radius: FOLKLORE.hauntRadius,
      })),
    };
  }
}

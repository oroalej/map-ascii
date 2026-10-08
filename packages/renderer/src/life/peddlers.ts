/** Separate population: never enters ordinary mover RNG, scenes, queues or reservations. */
import {
  DIALOGUE_WEATHER,
  SPEECH_ZOOM,
  type DialogueChoice,
  type GreetingPeriods,
  type PeddlerConfig,
  type PeddlerHours,
  type PeddlerProp,
} from '@atlas/shared';
import { EXTENT, tileToLngLat, lngLatToTile } from '../raster/geometry';
import type { TileId } from '../tiles';
import { LifeLine, SITE_STRIDE, type LifeGeometry } from './geometry';
import { hotAt, inHours, MAX_TILE_AGENTS, umbrellaShare } from './config';
import {
  PolygonIndex,
  bodyCorners,
  bodiesOverlap,
  sweptBodyOverlap,
  type Body,
  type Point,
} from './occupancy';
import { stripRing } from './terrain';
import { FIGURE_SIZE_M, type PersonLook } from './people';
import { random, hashString } from './random';
import { isPeddlerCart, peddlerCartOffset, Paint, VEHICLES } from './vehicles';
import type { LifeEnv, VisibleAgent } from './simulate';
import { PeddlerCaller } from './peddler-calls';
import { PeddlerEmojiObserver, type EmojiObservation } from './emoji';

export type PeddlerSignals = Pick<
  LifeEnv,
  'minutes' | 'rain' | 'sunAltitude' | 'windPreset' | 'wind' | 'pointer' | 'emojiView'
> & { wet: boolean; zoom?: number };
export function peddlerWindow(config: PeddlerConfig, minutes: number | undefined) {
  if (minutes === undefined) return;
  const hours = Array.isArray(config.hours) ? config.hours : [config.hours];
  const window = hours.find((h) => inHours(minutes, [h.from * 60, h.to * 60]));
  if (!window) return;
  const elapsed = (minutes - window.from * 60 + 1440) % 1440;
  const duration = (window.to - window.from + 24) % 24 || 24;
  return { window, elapsed, progress: elapsed / (duration * 60) };
}
export function peddlerShare(config: PeddlerConfig, env: PeddlerSignals) {
  if (env.windPreset === 'storm') return 0;
  const shares: number[] = [];
  if (env.wet) shares.push(config.weather?.rain ?? config.share ?? 1);
  if (hotAt(env.minutes, env.rain, env.sunAltitude))
    shares.push(config.weather?.heat ?? config.share ?? 1);
  if (env.windPreset === 'gusty') shares.push(config.weather?.wind ?? config.share ?? 1);
  return shares.length ? Math.min(...shares) : (config.share ?? 1);
}
export function peddlerBodies(prop: PeddlerProp, p: Point, hx: number, hy: number): Body[] {
  const body = { ...p, hx, hy, length: 1, width: 1 };
  if (!isPeddlerCart(prop)) {
    const width = Math.max(1, FIGURE_SIZE_M[prop]);
    return [{ ...body, length: width, width }];
  }
  const spec = VEHICLES[prop],
    offset = peddlerCartOffset(prop);
  return [
    body,
    {
      ...body,
      x: p.x + hx * offset,
      y: p.y + hy * offset,
      length: spec.length,
      width: Math.max(1, spec.width),
    },
  ];
}
type Route = {
  a: Point;
  b: Point;
  hx: number;
  hy: number;
  length: number;
  line: number;
  site?: Point;
};
export type PeddlerOwner = {
  x: number;
  y: number;
  hx: number;
  hy: number;
  config: PeddlerConfig;
  seed: number;
  rank: number;
  umbrellaRank: number;
  rng: () => number;
  route: Route;
  distance: number;
  dir: 1 | -1;
  walked: number;
  pause: number;
  nextCall: number;
  effectClock: number;
  leaving: boolean;
  callToken: number;
  lastCall: number;
  canopy: number;
  window?: PeddlerHours;
  waiting: number;
  identity: string;
  resumeToken: number;
  sheltered: boolean;
  shaded: boolean;
};
type Slot = {
  config: PeddlerConfig;
  seed: number;
  rank: number;
  births: number;
  owner?: PeddlerOwner;
};
export type PeddlerContext = {
  tile: TileId;
  geo: LifeGeometry;
  perMeter: number;
  seed: number;
  /** Metric swept static clearance, including uncut carriageways and neighboring tiles. */
  safe: (from: readonly Body[], to: readonly Body[]) => boolean;
  /** Read-only ordinary queries; peddlers cannot alter ordinary reservations. */
  ordinary: () => readonly Body[];
  held?: (owner: PeddlerOwner) => boolean;
  forget?: (owner: PeddlerOwner) => void;
  generation?: number;
};

function clipSegment(
  a: Point,
  b: Point,
  low: number,
  high: number,
  site?: Point,
  radius = Infinity,
): [Point, Point] | undefined {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let from = 0,
    to = 1;
  for (const [p, d] of [
    [a.x, dx],
    [a.y, dy],
  ]) {
    if (!d) {
      if (p! < low || p! > high) return;
      continue;
    }
    const aa = (low - p!) / d!,
      bb = (high - p!) / d!;
    from = Math.max(from, Math.min(aa, bb));
    to = Math.min(to, Math.max(aa, bb));
  }
  if (site) {
    const x = a.x - site.x,
      y = a.y - site.y,
      qa = dx * dx + dy * dy,
      qb = 2 * (x * dx + y * dy),
      qc = x * x + y * y - radius * radius,
      disc = qb * qb - 4 * qa * qc;
    if (disc < 0 || !qa) return;
    from = Math.max(from, (-qb - Math.sqrt(disc)) / (2 * qa));
    to = Math.min(to, (-qb + Math.sqrt(disc)) / (2 * qa));
  }
  if (to - from <= 1e-6) return;
  return [
    { x: a.x + dx * from, y: a.y + dy * from },
    { x: a.x + dx * to, y: a.y + dy * to },
  ];
}

export class PeddlerPopulation {
  readonly slots: Slot[];
  private readonly routes = new Map<PeddlerConfig, Route[]>();
  private ordinaryBodies: readonly Body[] = [];
  private readonly obstacles = new PolygonIndex();
  readonly caller: PeddlerCaller;
  readonly emoji = new PeddlerEmojiObserver();
  constructor(
    readonly context: PeddlerContext,
    readonly configs: readonly PeddlerConfig[],
    readonly presentation: {
      dialogue?: readonly DialogueChoice[];
      periods?: Readonly<GreetingPeriods>;
      emoji?: boolean;
    } = {},
  ) {
    this.caller = new PeddlerCaller(presentation.dialogue, presentation.periods);
    const { geo, perMeter } = context;
    for (let line = 0; line < geo.obstacleClosed.length; line++) {
      const points: Point[] = [];
      for (let v = geo.obstacleStarts[line]!; v < geo.obstacleStarts[line + 1]!; v++)
        points.push({
          x: geo.obstacles[v * 2]! / perMeter,
          y: geo.obstacles[v * 2 + 1]! / perMeter,
        });
      if (geo.obstacleClosed[line] && points.length >= 3) this.obstacles.add([points]);
      else
        for (let i = 1; i < points.length; i++) {
          const ring = stripRing(points[i - 1]!, points[i]!, 0.1);
          if (ring.length) this.obstacles.add([ring]);
        }
    }
    this.slots = configs.flatMap((config) =>
      Array.from({ length: config.perTile }, (_, i) => {
        const seed =
          (context.seed ^ hashString(config.id) ^ Math.imul(i + 1, 0x51ed270b) ^ 0x6a09e667) >>> 0;
        return { config, seed, rank: random(seed)(), births: 0 };
      }),
    );
  }
  get owners(): PeddlerOwner[] {
    return this.slots.flatMap((s) => (s.owner ? [s.owner] : []));
  }
  clear() {
    for (const slot of this.slots) this.remove(slot);
  }
  hide(owner?: PeddlerOwner) {
    for (const p of owner ? [owner] : this.owners) {
      this.caller.hide(p);
      this.emoji.forget(p);
    }
  }
  private remove(slot: Slot) {
    if (slot.owner) {
      this.context.forget?.(slot.owner);
      this.caller.forget(slot.owner);
      this.emoji.forget(slot.owner);
    }
    slot.owner = undefined;
  }
  private safe(config: PeddlerConfig, a: Point, b: Point, hx: number, hy: number, site?: Point) {
    const from = peddlerBodies(config.prop, a, hx, hy),
      to = peddlerBodies(config.prop, b, hx, hy);
    if (
      site &&
      config.near &&
      [...from, ...to].some((body) =>
        bodyCorners(body).some(
          (corner) => Math.hypot(corner.x - site.x, corner.y - site.y) > config.near!.reach + 1e-6,
        ),
      )
    )
      return false;
    return (
      !from.some((body, i) => this.obstacles.sweptHits(body, to[i]!)) && this.context.safe(from, to)
    );
  }
  private routesFor(config: PeddlerConfig): Route[] {
    const cached = this.routes.get(config);
    if (cached) return cached;
    const { geo, perMeter } = this.context,
      routes: Route[] = [];
    const sites: (Point | undefined)[] = config.near ? [] : [undefined];
    if (config.near)
      for (let s = 0; s < geo.sites.length; s += SITE_STRIDE)
        if (geo.sites[s + 2] === (config.near.kind === 'terminal' ? 1 : 0))
          sites.push({ x: geo.sites[s]! / perMeter, y: geo.sites[s + 1]! / perMeter });
    const radial = isPeddlerCart(config.prop)
      ? Math.hypot(peddlerCartOffset(config.prop) + VEHICLES[config.prop].length / 2, 0.5)
      : Math.max(1, FIGURE_SIZE_M[config.prop]) / Math.SQRT2;
    const add = (a: Point, b: Point, line: number, site: Point | undefined, depth = 0) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length < 0.1) return;
      const hx = (b.x - a.x) / length,
        hy = (b.y - a.y) / length;
      if (this.safe(config, a, b, hx, hy, site) && this.safe(config, b, a, -hx, -hy, site)) {
        routes.push({ a, b, hx, hy, length, line, site });
        return;
      }
      if (depth >= 12 || length < 2) return;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      add(a, mid, line, site, depth + 1);
      add(mid, b, line, site, depth + 1);
    };
    for (let line = 0; line < geo.kinds.length; line++) {
      if (!config.lines.some((kind) => geo.kinds[line] === LifeLine[kind])) continue;
      if (
        geo.widths[line]! > 0 &&
        geo.widths[line]! <
          Math.max(
            1,
            isPeddlerCart(config.prop) ? VEHICLES[config.prop].width : FIGURE_SIZE_M[config.prop],
          ) +
            0.1
      )
        continue;
      for (let v = geo.starts[line]!; v + 1 < geo.starts[line + 1]!; v++) {
        const a = { x: geo.coords[v * 2]! / perMeter, y: geo.coords[v * 2 + 1]! / perMeter },
          b = { x: geo.coords[v * 2 + 2]! / perMeter, y: geo.coords[v * 2 + 3]! / perMeter };
        for (const site of sites) {
          const clip = clipSegment(
            a,
            b,
            radial,
            EXTENT / perMeter - radial,
            site,
            (config.near?.reach ?? Infinity) - radial,
          );
          if (clip) add(clip[0], clip[1], line, site);
        }
      }
    }
    this.routes.set(config, routes);
    return routes;
  }
  private fits(owner: PeddlerOwner, target: Point, hx = owner.hx, hy = owner.hy) {
    if (!this.safe(owner.config, owner, target, hx, hy, owner.route.site)) return false;
    const from = peddlerBodies(owner.config.prop, owner, hx, hy),
      to = peddlerBodies(owner.config.prop, target, hx, hy);
    for (const bodies of [
      this.ordinaryBodies,
      ...this.owners
        .filter((p) => p !== owner)
        .map((p) => peddlerBodies(p.config.prop, p, p.hx, p.hy)),
    ])
      if (
        from.some((body, i) => bodies.some((other) => sweptBodyOverlap(body, to[i]!, other, 0.1)))
      )
        return false;
    // A heading change is checked with a conservative rotation envelope, not a snapping shortcut.
    if (hx !== owner.hx || hy !== owner.hy) {
      const radial = Math.max(
        ...[...from, ...peddlerBodies(owner.config.prop, owner, owner.hx, owner.hy)]
          .flatMap((body) => bodyCorners(body))
          .map((p) => Math.hypot(p.x - owner.x, p.y - owner.y)),
      );
      const envelope = {
        x: owner.x,
        y: owner.y,
        hx: 1,
        hy: 0,
        length: radial * 2,
        width: radial * 2,
      };
      if (
        !this.context.safe([envelope], [envelope]) ||
        this.obstacles.hits([envelope]) ||
        [
          ...this.ordinaryBodies,
          ...this.owners
            .filter((p) => p !== owner)
            .flatMap((p) => peddlerBodies(p.config.prop, p, p.hx, p.hy)),
        ].some((b) => bodiesOverlap(envelope, b))
      )
        return false;
    }
    return true;
  }
  step(dt: number, env: PeddlerSignals, ordinaryPopulation: number) {
    const pointer = env.pointer && lngLatToTile(this.context.tile, ...env.pointer.lngLat);
    const hovered = (owner: PeddlerOwner) =>
      !!pointer &&
      (owner.x * this.context.perMeter - pointer.x) ** 2 +
        (owner.y * this.context.perMeter - pointer.y) ** 2 <=
        (3 * env.pointer!.cellMeters * this.context.perMeter) ** 2;
    const eligible = (owner: PeddlerOwner) => {
      if ((env.zoom ?? 0) < SPEECH_ZOOM) return false;
      const bounds = env.emojiView?.bounds;
      if (!bounds) return true;
      const [lng, lat] = tileToLngLat(this.context.tile, {
        x: owner.x * this.context.perMeter,
        y: owner.y * this.context.perMeter,
      });
      return lng >= bounds[0] && lng <= bounds[2] && lat >= bounds[1] && lat <= bounds[3];
    };
    this.ordinaryBodies = this.context.ordinary();
    let count = this.owners.length;
    for (const slot of this.slots) {
      const window = peddlerWindow(slot.config, env.minutes),
        share = peddlerShare(slot.config, env);
      if (
        !slot.owner &&
        window &&
        slot.rank < share &&
        env.rain < DIALOGUE_WEATHER.heavyRain &&
        count + ordinaryPopulation < MAX_TILE_AGENTS
      ) {
        const routes = this.routesFor(slot.config),
          rng = random(slot.seed ^ Math.imul(++slot.births, 0x85ebca6b));
        const first = Math.floor(rng() * routes.length);
        for (let trial = 0; trial < Math.min(8, routes.length); trial++) {
          const route = routes[(first + trial) % routes.length]!,
            dir = rng() < 0.5 ? 1 : -1,
            p = dir === 1 ? route.a : route.b;
          const owner: PeddlerOwner = {
            ...p,
            hx: route.hx * dir,
            hy: route.hy * dir,
            config: slot.config,
            seed: slot.seed,
            rank: slot.rank,
            umbrellaRank: rng(),
            rng,
            route,
            dir,
            distance: dir === 1 ? 0 : route.length,
            walked: 0,
            pause: 0,
            nextCall: 40 + rng() * 50,
            effectClock: 0,
            leaving: false,
            callToken: 0,
            lastCall: 0,
            canopy: 0,
            window: window.window,
            waiting: 0,
            identity: `${this.context.generation ?? 0}:${this.context.tile.z}/${this.context.tile.x}/${this.context.tile.y}:${slot.config.id}:${slot.seed}:${slot.births}`,
            resumeToken: 0,
            sheltered: false,
            shaded: false,
          };
          if (this.fits(owner, owner)) {
            slot.owner = owner;
            count++;
            break;
          }
        }
      }
      const owner = slot.owner;
      if (!owner) continue;
      if (!window || slot.rank >= share) owner.leaving = true;
      this.caller.step(owner, dt, env, eligible(owner), hovered(owner));
      if (this.context.held?.(owner)) continue;
      owner.effectClock += dt;
      owner.window = window?.window ?? owner.window;
      const open =
        env.windPreset !== 'gusty' &&
        env.windPreset !== 'storm' &&
        owner.umbrellaRank < umbrellaShare(env.rain, env.sunAltitude ?? -90);
      owner.canopy = Math.max(0, Math.min(1, owner.canopy + (open ? 1 : -1) * dt));
      if (owner.pause > 0 && !owner.leaving) {
        owner.pause = Math.max(0, owner.pause - dt);
        continue;
      }
      owner.nextCall -= dt;
      if (owner.nextCall <= 0 && !owner.leaving) {
        owner.pause = 5 + owner.rng() * 10;
        owner.nextCall = 40 + owner.rng() * 50;
        owner.callToken++;
        owner.lastCall = owner.effectClock;
        this.caller.step(owner, 0, env, eligible(owner), hovered(owner));
        continue;
      }
      const travel = dt * 1.2 * 0.7 * (env.wet && owner.canopy > 0 ? 0.8 : 1),
        distance = Math.max(0, Math.min(owner.route.length, owner.distance + travel * owner.dir)),
        target = {
          x: owner.route.a.x + owner.route.hx * distance,
          y: owner.route.a.y + owner.route.hy * distance,
        };
      if (!this.fits(owner, target)) {
        owner.waiting += dt;
        if (owner.waiting >= 2 && this.fits(owner, owner, -owner.hx, -owner.hy)) {
          owner.dir = owner.dir === 1 ? -1 : 1;
          owner.hx = -owner.hx;
          owner.hy = -owner.hy;
          owner.waiting = 0;
        }
        continue;
      }
      owner.waiting = 0;
      owner.walked += Math.hypot(target.x - owner.x, target.y - owner.y);
      Object.assign(owner, target);
      owner.distance = distance;
      if (distance > 1e-6 && distance < owner.route.length - 1e-6) continue;
      if (owner.leaving) {
        this.remove(slot);
        count--;
        continue;
      }
      const next = this.routesFor(owner.config).flatMap((route) => {
        const atA = Math.hypot(route.a.x - owner.x, route.a.y - owner.y) < 0.02,
          atB = Math.hypot(route.b.x - owner.x, route.b.y - owner.y) < 0.02;
        if (!atA && !atB) return [];
        const dir: 1 | -1 = atA ? 1 : -1;
        return this.fits(owner, owner, route.hx * dir, route.hy * dir) ? [{ route, dir }] : [];
      });
      if (next.length) {
        const chosen = next[Math.floor(owner.rng() * next.length)]!;
        owner.route = chosen.route;
        owner.dir = chosen.dir;
        owner.distance = chosen.dir === 1 ? 0 : chosen.route.length;
        owner.hx = chosen.route.hx * chosen.dir;
        owner.hy = chosen.route.hy * chosen.dir;
      }
    }
    const observations: EmojiObservation[] = this.owners.map((owner) => {
      const clock = peddlerWindow(owner.config, env.minutes),
        t = this.caller.state(owner);
      return {
        owner,
        subject: 'person',
        figure: 'adult',
        eligible: this.presentation.emoji !== false && eligible(owner),
        speaking: !!this.caller.cue(owner, env.zoom),
        peddler: {
          goods: owner.config.id,
          cart: isPeddlerCart(owner.config.prop),
          call: owner.config.call ?? 'voice',
          progress: clock?.progress ?? 1,
          elapsed: clock?.elapsed ?? 0,
          dawn: (owner.window?.from ?? 24) < 6,
          wrappingNight:
            !!owner.window &&
            owner.window.from > owner.window.to &&
            (env.minutes ?? 1440) < owner.window.to * 60,
          leaving: owner.leaving,
          umbrella: owner.canopy > 0,
          shade: owner.shaded,
          shelter: owner.sheltered,
          waitingNear: !!owner.config.near && owner.waiting > 3,
          sinceCall: owner.effectClock - owner.lastCall,
          resumeToken: owner.resumeToken,
          callToken: t.serial,
          hover: t.event === 'hover',
          heat: owner.config.emoji?.heat,
        },
      };
    });
    this.emoji.step(dt, env, observations);
  }
  visible(owner: PeddlerOwner, env: PeddlerSignals): VisibleAgent {
    const { tile, perMeter } = this.context,
      at = (x: number, y: number) => tileToLngLat(tile, { x: x * perMeter, y: y * perMeter }),
      [lng, lat] = at(owner.x, owner.y),
      prop = owner.config.prop,
      carrier = isPeddlerCart(prop) ? 'adult' : prop;
    const look: PersonLook = {
      figure: carrier,
      paint: Paint.orange,
      lateral: 0,
      back: 0,
      flap: Math.floor(owner.walked / 0.6) % 2,
    };
    if (!isPeddlerCart(prop) && owner.canopy > 0) {
      look.figure = 'umbrella';
      look.paint = Paint.graphite;
      look.canopy = { open: owner.canopy, figure: carrier, paint: Paint.orange };
    }
    const flicker =
      env.windPreset === 'gusty'
        ? 1 -
          Math.min(0.5, (env.wind?.strength ?? 0) * 0.25) *
            (0.5 + 0.5 * Math.sin(owner.effectClock * 11 + owner.seed))
        : 1;
    return {
      kind: 'person',
      lng,
      lat,
      ahead: at(owner.x + owner.hx, owner.y + owner.hy),
      side: at(owner.x - owner.hy, owner.y + owner.hx),
      people: [look],
      flap: look.flap,
      speech: this.caller.cue(owner, env.zoom),
      emoji: (env.zoom ?? 0) >= SPEECH_ZOOM ? this.emoji.cue(owner) : undefined,
      paint: isPeddlerCart(prop)
        ? VEHICLES[prop].paints[owner.seed % VEHICLES[prop].paints.length]!
        : Paint.orange,
      peddler: {
        id: owner.config.id,
        label: owner.config.label,
        prop,
        parasol: prop === 'box-cart' ? owner.canopy : 0,
        lamp: owner.config.lamp && (env.sunAltitude ?? 0) < 0 ? flicker : 0,
      },
    };
  }
}

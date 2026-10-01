/** Adapts authoritative visits and existing group members to presentation-only dialogue. */
import type { MomentOptions } from './moments-host';
import { MOMENTS, type MomentAnchor } from './moments';
import { inTile } from './geometry';
import { SceneSpeech, type SceneSpeaker } from './scene-speech';
import type { LifeEnv, Mover, Stall, TileLife } from './simulate';

export class SceneSpeechHost {
  readonly speech: SceneSpeech;
  private readonly enabled: boolean;
  private sceneCursor = 0;
  private sceneTime = 0;
  private sceneScan = 0;
  private sceneBudget = 2;
  private previousRain = 0;
  private sceneEnv: LifeEnv | undefined;
  private sceneNear?: (x: number, y: number) => boolean;
  private sceneKeys = new WeakMap<object, { state: string; key: object }>();
  constructor(
    private readonly tile: TileLife,
    seed: number,
    options: MomentOptions,
  ) {
    this.enabled = options.enabled !== false && !!options.dialogue?.some((e) => e.profile);
    this.speech = new SceneSpeech(seed, options.dialogue ?? [], options.periods, options.memory);
  }
  clear() {
    this.speech.clear();
    this.sceneKeys = new WeakMap();
  }
  step(
    dt: number,
    zoom: number,
    env: LifeEnv | undefined,
    near: ((x: number, y: number) => boolean) | undefined,
    anchors: readonly MomentAnchor[],
  ) {
    const { tile } = this;
    this.sceneEnv = env;
    this.sceneNear = near;
    this.sceneTime += dt;
    this.speech.step(dt, this.enabled && zoom >= MOMENTS.zoom);
    let sceneChecks = 0;
    if (this.enabled && zoom >= MOMENTS.zoom) {
      const keyFor = (owner: object, state: string) => {
        let entry = this.sceneKeys.get(owner);
        if (!entry || entry.state !== state) {
          entry = { state, key: {} };
          this.sceneKeys.set(owner, entry);
        }
        return entry.key;
      };
      const visible = (owner: Mover | Stall) =>
        (!this.sceneNear || this.sceneNear(owner.x, owner.y)) &&
        inTile(owner) &&
        owner.rank < (this.sceneEnv?.levels?.person ?? 1) &&
        ('kind' in owner
          ? tile.movers.includes(owner) &&
            !tile.scenes.hidden(owner) &&
            !tile.momentHost.moments.busy(owner)
          : tile.stalls.includes(owner) && owner.open !== false);
      const tryScene = (m: Mover, arrival = false) => {
        if (!m.group?.length || !visible(m)) return;
        const visit = tile.scenes.visits.get(m);
        const context = {
          minutes: env?.minutes ?? 720,
          rain: env?.rain ?? 0,
          wind: env?.wind?.strength ?? 0,
          easing: (env?.rain ?? 0) < this.previousRain - 0.001,
          figures: [] as string[],
          anchors: anchors
            .filter((a) => Math.hypot(a.x - m.x, a.y - m.y) / tile.perMeter <= MOMENTS.look.reach)
            .map((a) => a.kind!),
          arrival,
        };
        const first: SceneSpeaker = { owner: m, member: 0, figure: m.group[0]!.figure };
        if (visit?.state === 'purchase' && visit.site.stall) {
          const vendor = visit.site.stall;
          this.speech.admit(
            {
              key: keyFor(visit, 'purchase'),
              speakers: [first, { owner: vendor, member: 0, figure: 'adult' }],
              profiles: ['vendor-order', 'vendor-thanks'],
              context,
              remaining: visit.time,
              valid: () =>
                visible(m) &&
                visible(vendor) &&
                tile.scenes.visits.get(m) === visit &&
                visit.state === 'purchase' &&
                (this.sceneEnv?.rain ?? 0) < MOMENTS.rain,
            },
            MOMENTS.capacity - tile.momentHost.moments.size,
          );
        } else if (
          visit &&
          (visit.state === 'wait' || visit.state === 'shelter') &&
          visit.site.kind !== 'vendor'
        ) {
          const other = visit.site.queue.find(
            (person) =>
              person !== m &&
              person.group?.length &&
              visible(person) &&
              tile.scenes.visits.get(person)?.state === visit.state,
          );
          const second =
            m.group.length > 1
              ? { owner: m, member: 1, figure: m.group[1]!.figure }
              : other
                ? { owner: other, member: 0, figure: other.group![0]!.figure }
                : undefined;
          if (!second) return;
          const sheltered = visit.state === 'shelter' && visit.site.covered;
          if (!sheltered && visit.site.kind !== 'stop' && visit.site.kind !== 'terminal') return;
          const state = visit.state;
          const pair = second.owner;
          this.speech.admit(
            {
              key: keyFor(
                visit,
                `${state}:${arrival ? 'arrival' : context.easing ? 'easing' : 'wait'}`,
              ),
              speakers: [first, second],
              profiles: sheltered ? ['weather'] : ['transit'],
              context: { ...context, sheltered },
              valid: () =>
                visible(m) &&
                visible(pair) &&
                tile.scenes.visits.get(m) === visit &&
                visit.state === state &&
                (pair === m ||
                  (tile.scenes.visits.get(pair)?.state === state &&
                    tile.scenes.visits.get(pair)?.site === visit.site)) &&
                (sheltered
                  ? (this.sceneEnv?.rain ?? 0) > 0.2
                  : (this.sceneEnv?.rain ?? 0) < MOMENTS.rain),
            },
            MOMENTS.capacity - tile.momentHost.moments.size,
          );
        } else if (!visit && m.group.length > 1 && (env?.rain ?? 0) < MOMENTS.rain) {
          const state = String(Math.floor(this.sceneTime / MOMENTS.cooldown));
          this.speech.admit(
            {
              key: keyFor(m, state),
              speakers: [first, { owner: m, member: 1, figure: m.group[1]!.figure }],
              profiles: ['companion'],
              context,
              valid: () =>
                visible(m) &&
                !tile.scenes.visits.has(m) &&
                (this.sceneEnv?.rain ?? 0) < MOMENTS.rain,
            },
            MOMENTS.capacity - tile.momentHost.moments.size,
          );
        }
      };
      const scan = this.sceneTime >= this.sceneScan;
      if (scan) {
        this.sceneScan = this.sceneTime + MOMENTS.interval;
        this.sceneBudget = 2;
      }
      for (const event of tile.scenes.speechEvents.slice(0, this.sceneBudget)) {
        sceneChecks++;
        this.sceneBudget--;
        tryScene(event.mover, event.kind === 'arrival');
      }
      if (scan) {
        while (this.sceneBudget > 0 && tile.movers.length) {
          sceneChecks++;
          this.sceneBudget--;
          tryScene(tile.movers[this.sceneCursor++ % tile.movers.length]!);
        }
      }
    }
    this.previousRain = env?.rain ?? 0;
    // Reserve two of the shared eight checks, even on frames between free-moment scans.
    return this.enabled && zoom >= MOMENTS.zoom ? 2 : sceneChecks;
  }
}

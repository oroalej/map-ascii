import { gathererShare } from './gatherer-share';
/** Adapts authoritative visits and existing group members to presentation-only dialogue. */
import type { MomentOptions } from './moments-host';
import { MOMENTS, type MomentAnchor } from './moments';
import { inTile } from './geometry';
import { SceneSpeech, type SceneSpeaker } from './scene-speech';
import type { Gatherer, LifeEnv, Mover, Stall, TileLife } from './simulate';
import { DIALOGUE_WEATHER } from '@atlas/shared';
import { makeDialogueContext } from './dialogue';
import { hotAt } from './config';
import type { LocalScenes } from './interactions';

export class SceneSpeechHost {
  readonly speech: SceneSpeech;
  private readonly enabled: boolean;
  private sceneCursor = 0;
  private sceneTime = 0;
  private sceneScan = MOMENTS.interval as number;
  private sceneBudget = MOMENTS.scene.checks as number;
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
    this.speech.step(dt, this.enabled && zoom >= MOMENTS.zoom, env?.clock);
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
      const visible = (owner: Mover | Stall | Gatherer) =>
        (!this.sceneNear || this.sceneNear(owner.x, owner.y)) &&
        inTile(owner) &&
        owner.rank <
          ('place' in owner
            ? gathererShare(owner, this.sceneEnv?.levels)
            : (this.sceneEnv?.levels?.person ?? 1)) &&
        ('kind' in owner
          ? tile.movers.includes(owner) &&
            !tile.scenes.hidden(owner) &&
            !tile.momentHost.moments.busy(owner)
          : 'place' in owner
            ? tile.gatherers.includes(owner) && !tile.momentHost.moments.busy(owner)
            : tile.stalls.includes(owner) && owner.open !== false);
      const contextFor = (owner: Mover | Gatherer) => ({
        ...makeDialogueContext([owner], anchors, {
          perMeter: tile.perMeter,
          reach: MOMENTS.look.reach,
          minutes: env?.minutes,
          rain: env?.rain,
          wind: env?.wind?.strength,
        }).context,
        easing: (env?.rain ?? 0) < this.previousRain - 0.001,
        sunAltitude: env?.sunAltitude,
      });
      const tryAmbient = (owner: Mover | Gatherer) => {
        if (
          ('seasonal' in owner && owner.seasonal) ||
          !visible(owner) ||
          (env?.rain ?? 0) >= MOMENTS.rain
        )
          return;
        const eligible = () =>
          visible(owner) &&
          (this.sceneEnv?.rain ?? 0) < MOMENTS.rain &&
          ('kind' in owner
            ? owner.kind === 'person' && owner.group?.length === 1 && !tile.scenes.visits.has(owner)
            : owner.behavior !== 'work' && owner.carabao === undefined);
        if (!eligible()) return;
        const now = env?.clock ?? this.sceneTime;
        const memory = this.speech.selector.memory;
        if (!memory.ambientReady([owner], now) || !memory.ambientAttempt(owner, now)) return;
        const walker = 'kind' in owner ? owner.group![0]! : owner.walker;
        this.speech.admit(
          {
            key: keyFor(owner, `ambient:${Math.floor(now / MOMENTS.cooldown)}`),
            speakers: [{ owner, member: 0, figure: walker.figure }],
            profiles: ['weather', 'food', 'school', 'daily-plans'],
            context: { ...contextFor(owner), delivery: 'utterance' },
            ambient: true,
            stationary: () => owner.pause > 0 || ('behavior' in owner && owner.behavior === 'sit'),
            valid: eligible,
          },
          MOMENTS.capacity - tile.momentHost.moments.size,
        );
      };
      const tryClearing = (event: LocalScenes['speechEvents'][number]) => {
        const { site } = event.visit;
        const eligible = (m: Mover) => {
          const v = tile.scenes.visits.get(m);
          return (
            m.kind === 'person' &&
            !!m.group?.length &&
            visible(m) &&
            v?.site === site &&
            v.state === 'shelter' &&
            v.sheltering &&
            !v.returnPending &&
            v.leave !== undefined &&
            Number.isFinite(v.leave) &&
            v.leave > 0 &&
            event.shower !== undefined &&
            v.leaveShower === event.shower &&
            !tile.scenes.raining &&
            (this.sceneEnv?.rain ?? 0) <= DIALOGUE_WEATHER.easing
          );
        };
        const pending = site.queue
          .filter(eligible)
          .sort((a, b) => tile.scenes.visits.get(b)!.leave! - tile.scenes.visits.get(a)!.leave!);
        const m = pending[0];
        if (!m) return;
        const other = pending[1];
        const speakers: SceneSpeaker[] = [{ owner: m, member: 0, figure: m.group![0]!.figure }];
        if (m.group!.length > 1)
          speakers.push({ owner: m, member: 1, figure: m.group![1]!.figure });
        else if (other) speakers.push({ owner: other, member: 0, figure: other.group![0]!.figure });
        const participants = [...new Set(speakers.map((s) => s.owner as Mover))].map((owner) => ({
          owner,
          visit: tile.scenes.visits.get(owner)!,
        }));
        this.speech.admit(
          {
            key: event.key,
            speakers,
            profiles: ['weather'],
            context: { ...contextFor(m), sheltered: true, clearing: true },
            remaining: Math.min(...participants.map(({ visit }) => visit.leave!)),
            valid: () =>
              participants.every(
                ({ owner, visit }) =>
                  site.queue.includes(owner) &&
                  eligible(owner) &&
                  tile.scenes.visits.get(owner) === visit,
              ),
          },
          MOMENTS.capacity - tile.momentHost.moments.size,
        );
      };
      const tryScene = (m: Mover, arrival = false, event?: LocalScenes['speechEvents'][number]) => {
        if (event?.kind === 'clearing') {
          tryClearing(event);
          return;
        }
        if (!m.group?.length || !visible(m)) return;
        const visit = tile.scenes.visits.get(m);
        const context = { ...contextFor(m), arrival };
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
          (visit.state === 'wait' || visit.state === 'shelter' || visit.state === 'shade') &&
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
          const sheltered = visit.state === 'shelter' && visit.site.covered;
          const shaded = visit.state === 'shade';
          if (!sheltered && !shaded && visit.site.kind !== 'stop' && visit.site.kind !== 'terminal')
            return;
          const state = visit.state;
          const pair = second?.owner;
          const pairVisit = pair && pair !== m ? tile.scenes.visits.get(pair) : visit;
          this.speech.admit(
            {
              key: keyFor(
                visit,
                `${state}:${arrival ? 'arrival' : context.easing ? 'easing' : 'wait'}`,
              ),
              speakers: second ? [first, second] : [first],
              profiles: sheltered || shaded ? ['weather'] : ['transit'],
              context: { ...context, sheltered, shaded },
              remaining: shaded ? Math.min(visit.time, pairVisit?.time ?? visit.time) : undefined,
              valid: () =>
                visible(m) &&
                (!pair || visible(pair)) &&
                tile.scenes.visits.get(m) === visit &&
                visit.state === state &&
                (!pair ||
                  pair === m ||
                  (tile.scenes.visits.get(pair) === pairVisit &&
                    pairVisit?.state === state &&
                    tile.scenes.visits.get(pair)?.site === visit.site)) &&
                (shaded
                  ? hotAt(
                      this.sceneEnv?.minutes,
                      this.sceneEnv?.rain ?? 0,
                      this.sceneEnv?.sunAltitude,
                    )
                  : sheltered
                    ? (this.sceneEnv?.rain ?? 0) > DIALOGUE_WEATHER.easing
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
              stationary: () => m.pause > 0,
              valid: () =>
                visible(m) &&
                !tile.scenes.visits.has(m) &&
                (this.sceneEnv?.rain ?? 0) < MOMENTS.rain,
            },
            MOMENTS.capacity - tile.momentHost.moments.size,
          );
        } else if (!visit && m.group.length === 1) tryAmbient(m);
      };
      let scan = false;
      while (this.sceneTime + 1e-9 >= this.sceneScan) {
        this.sceneScan += MOMENTS.interval;
        scan = true;
      }
      if (scan) this.sceneBudget = MOMENTS.scene.checks;
      for (const event of tile.scenes.speechEvents) {
        if (!this.sceneBudget) break;
        sceneChecks++;
        this.sceneBudget--;
        tryScene(event.mover, event.kind === 'arrival', event);
      }
      if (scan) {
        // Keep one check available for real service events between scan boundaries.
        // Spending both on background companions can miss a short purchase entirely.
        const ordinary = tile.ordinaryGatherers;
        const count = tile.movers.length + ordinary.length;
        while (this.sceneBudget > 1 && count) {
          sceneChecks++;
          this.sceneBudget--;
          const index = this.sceneCursor++ % count;
          if (index < tile.movers.length) tryScene(tile.movers[index]!);
          else tryAmbient(ordinary[index - tile.movers.length]!);
        }
      }
    }
    this.previousRain = env?.rain ?? 0;
    // Reserve two of the shared eight checks, even on frames between free-moment scans.
    return this.enabled && zoom >= MOMENTS.zoom ? MOMENTS.scene.checks : sceneChecks;
  }
}

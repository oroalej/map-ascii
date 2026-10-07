import type { EmergencyConfig } from '@atlas/shared';
import { EMERGENCY, type EmergencyKind, type EmergencyState } from './emergency';
import { hashString, random } from './random';
import type { Mover, TileLife } from './simulate';
import type { EmergencyRouter } from './emergency-network';

export type EmergencyOwner = { life: TileLife; mover: Mover };
export type EmergencyRequest = {
  kind: EmergencyKind;
  run: number;
  attempt: number;
  station?: string;
  target?: string;
};
type Clock = {
  seed: number;
  draws: number;
  left: number;
  run: number;
  attempt: number;
  rng: () => number;
};
/** Dedicated streams and logical reservations never consume ordinary population randomness. */
export class EmergencyDispatch {
  private clocks = new Map<EmergencyKind, Clock>();
  private reservations = new Map<string, EmergencyOwner>();
  constructor(
    readonly config: EmergencyConfig,
    readonly router: EmergencyRouter,
    salt = 0x763acf91,
  ) {
    for (const kind of ['ambulance', 'police', 'fire'] as const) {
      if (!config[kind]?.max) continue;
      const seed = hashString(`emergency/${kind}`) ^ salt;
      this.clocks.set(kind, { seed, draws: 0, left: 0, run: 0, attempt: 0, rng: random(seed) });
      this.clocks.get(kind)!.left = this.draw(kind, config[kind]!.interval_s);
    }
  }
  private draw(kind: EmergencyKind, range: readonly [number, number]) {
    const clock = this.clocks.get(kind)!;
    clock.draws++;
    return range[0] + (range[1] - range[0]) * clock.rng();
  }
  reconcile(owners: readonly EmergencyOwner[]) {
    this.reservations.clear();
    for (const owner of owners)
      if (owner.mover.emergency) this.reservations.set(owner.mover.emergency.id, owner);
  }
  release(m: Mover) {
    if (m.emergency) this.reservations.delete(m.emergency.id);
  }
  clear() {
    this.reservations.clear();
  }
  snapshot() {
    return {
      clocks: [...this.clocks].map(([kind, c]) => ({
        kind,
        seed: c.seed,
        draws: c.draws,
        left: c.left,
        run: c.run,
        attempt: c.attempt,
      })),
      reservations: [...this.reservations].map(([id, { life, mover }]) => ({
        id,
        owner: life.tile,
        state: { ...mover.emergency! },
      })),
    };
  }
  private fireTarget(station: string, run: number) {
    const origin = this.router.targets.get(station)!.at;
    const targets = this.router.network.targets.filter(
      (t) => t.kind === 'building' && this.router.path(origin, t.id).length,
    );
    return targets[hashString(`fire/${run}`) % targets.length]?.id;
  }
  step(
    dt: number,
    owners: readonly EmergencyOwner[],
    active: (owner: EmergencyOwner) => boolean,
    outside: (owner: EmergencyOwner) => boolean,
    arrived: (owner: EmergencyOwner) => boolean,
    spawn: (request: EmergencyRequest) => EmergencyOwner | undefined,
    remove: (owner: EmergencyOwner) => void,
  ) {
    this.reconcile(owners);
    for (const owner of this.reservations.values()) {
      if (!active(owner)) continue;
      const { mover: m, life } = owner,
        old = m.emergency!;
      let state: EmergencyState = old;
      if (old.kind === 'police') {
        const remaining = Math.max(0, old.remaining - dt);
        state = { ...old, remaining };
        if (!remaining) {
          const call = old.phase === 'patrol',
            cfg = this.config.police!;
          state = {
            ...state,
            phase: call ? 'call' : 'patrol',
            lights: call,
            remaining: this.draw('police', call ? cfg.call_s : cfg.call_every_s),
          };
          m.speed = old.baseSpeedMps * life.perMeter * (call ? 1.3 : 1);
        }
      } else if (old.phase === 'parked' || old.phase === 'onscene') {
        state = { ...old, remaining: Math.max(0, old.remaining - dt) };
        if (!state.remaining) {
          state = {
            ...state,
            phase: old.kind === 'fire' ? 'returning' : 'cleared',
            lights: false,
            target: old.kind === 'fire' ? old.station : undefined,
          };
          if (old.kind === 'ambulance') {
            const { target: _target, ...cleared } = state;
            state = cleared;
          }
          m.routing = { seed: m.routing!.seed, turns: m.routing!.turns };
        }
      } else if (
        (old.phase === 'responding' || old.phase === 'arriving' || old.phase === 'returning') &&
        arrived(owner)
      ) {
        const returning = old.phase === 'returning';
        state = {
          ...old,
          phase: returning ? 'held' : old.kind === 'fire' ? 'onscene' : 'parked',
          lights: !returning && old.kind === 'fire',
          remaining: returning
            ? 0
            : this.draw(
                old.kind,
                old.kind === 'fire' ? this.config.fire!.dwell_s : this.config.ambulance!.dwell_s,
              ),
        };
        m.v = 0;
      }
      if (
        state.phase === 'responding' &&
        (life.emergencyArrival(m)?.remaining ?? Infinity) < EMERGENCY.approachM
      )
        state = { ...state, phase: 'arriving' };
      const releasable = state.phase === 'cleared' || state.phase === 'patrol';
      if (releasable) {
        state = { ...state, offscreen: outside(owner) ? state.offscreen + dt : 0 };
        const duration =
          state.kind === 'ambulance' ? EMERGENCY.ambulanceReleaseS : EMERGENCY.policeReleaseS;
        if (state.offscreen >= duration) {
          remove(owner);
          this.release(m);
          continue;
        }
      } else if (state.offscreen) state = { ...state, offscreen: 0 };
      m.emergency = state;
    }
    for (const [kind, clock] of this.clocks) {
      clock.left = Math.max(0, clock.left - dt);
      if (clock.left) continue;
      const cfg = this.config[kind]!,
        current = [...this.reservations.values()].filter((o) => o.mover.emergency!.kind === kind);
      const held =
        kind === 'fire'
          ? current.find((o) => o.mover.emergency!.phase === 'held' && active(o))
          : undefined;
      if (!held && current.length >= cfg.max) continue;
      const run = clock.run + 1;
      const stations = this.router.network.targets.filter(
        (t) => t.kind === (kind === 'fire' ? 'fire' : 'police'),
      );
      const station =
        kind === 'ambulance'
          ? undefined
          : (held?.mover.emergency?.station ??
            stations[hashString(`${kind}/${run}`) % stations.length]?.id);
      const target = kind === 'fire' && station ? this.fireTarget(station, run) : undefined;
      if (kind === 'fire' && !target) continue;
      const owner = held ?? spawn({ kind, run, attempt: clock.attempt++, station, target });
      if (!owner) continue;
      if (held) {
        owner.mover.emergency = {
          ...owner.mover.emergency!,
          phase: 'responding',
          lights: true,
          target,
          remaining: 0,
          offscreen: 0,
          run,
        };
        owner.mover.routing = {
          seed: owner.mover.routing!.seed,
          turns: owner.mover.routing!.turns,
        };
      } else if (kind === 'police')
        owner.mover.emergency = {
          ...owner.mover.emergency!,
          remaining: this.draw(kind, this.config.police!.call_every_s),
        };
      this.reservations.set(owner.mover.emergency!.id, owner);
      clock.run = run;
      clock.attempt = 0;
      clock.left = this.draw(kind, cfg.interval_s);
    }
  }
}

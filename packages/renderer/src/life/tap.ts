import type { VisibleAgent } from './simulate';
import type { EmojiRequest } from './emoji';
import type { SeasonalCarnivalRecord } from '@atlas/shared';

export type TapAction =
  | 'folklore'
  | 'agent'
  | 'signal'
  | 'procession'
  | 'carnival'
  | 'candle'
  | 'tree'
  | 'firework'
  | 'rice';
export type LifeTap = {
  id: number;
  generation: number;
  frame: number;
  at: readonly [number, number];
  pointer: string;
  pointerRevision?: number;
  cellMeters: number;
  agent?: number;
  folklore?: string;
  signal?: { seed: number; midBlock: boolean };
  carnival?: { key: string; at: readonly [number, number]; record?: SeasonalCarnivalRecord };
  candle?: { key: string; at: readonly [number, number]; seed?: number };
  firework?: boolean;
};
export type TapReceipt = { id: number; action?: TapAction };
export type TapTarget = { owner: object; agent: VisibleAgent };

/** Source-frame lookups do not select, hold, or change a drawable's identity fields. */
export class TapSources {
  private serial = 0;
  private owners = new Map<VisibleAgent, object>();
  private frames: { frame: number; targets: (TapTarget | undefined)[] }[] = [];
  get frame() {
    return this.serial;
  }
  begin() {
    this.owners.clear();
  }
  present(owner: object, agent: VisibleAgent) {
    this.owners.set(agent, owner);
  }
  finish(agents: readonly VisibleAgent[]) {
    const targets = agents.map((agent) => {
      const owner = this.owners.get(agent);
      return owner ? { owner, agent } : undefined;
    });
    this.frames.push({ frame: ++this.serial, targets });
    // Two GPU-read frames, the pipelined worker and a rejected busy request can overlap.
    // Keep a bounded window without recycling handles or extending lifecycle validity.
    if (this.frames.length > 8) this.frames.shift();
    this.owners.clear();
  }
  read(tap: Pick<LifeTap, 'frame' | 'agent'>) {
    const source = this.frames.find((f) => f.frame === tap.frame);
    return (
      source && {
        targets: source.targets,
        target: tap.agent === undefined ? undefined : source.targets[tap.agent],
      }
    );
  }
  latest() {
    return this.frames[this.frames.length - 1]?.targets ?? [];
  }
  clear() {
    this.frames.length = 0;
    this.owners.clear();
    // Never recycle frame handles after reset.
    this.serial++;
  }
}

export type TapHandlers = {
  folklore: (id: string, tap: LifeTap) => boolean;
  agent: (target: TapTarget, tap: LifeTap) => void;
  signal: (tap: LifeTap) => boolean;
  procession: (tap: LifeTap) => boolean;
  carnival: (tap: LifeTap) => void;
  candle: (tap: LifeTap) => void;
  tree: (tap: LifeTap) => boolean;
  rice: (tap: LifeTap) => boolean;
};

/** A matched but busy subject consumes its tap. Only absent subjects can fall through. */
export function resolveTap(tap: LifeTap, sources: TapSources, h: TapHandlers): TapReceipt {
  const source = sources.read(tap);
  if (!source || (tap.agent !== undefined && !source.target)) return { id: tap.id };
  let action: TapAction | undefined;
  if (tap.folklore && h.folklore(tap.folklore, tap)) action = 'folklore';
  else if (source.target) {
    h.agent(source.target, tap);
    action = 'agent';
  } else if (h.signal(tap)) action = 'signal';
  else if (h.procession(tap)) action = 'procession';
  else if (tap.carnival) {
    h.carnival(tap);
    action = 'carnival';
  } else if (tap.candle) {
    h.candle(tap);
    action = 'candle';
  } else if (h.tree(tap)) action = 'tree';
  else if (tap.firework) action = 'firework';
  else if (h.rice(tap)) action = 'rice';
  return { id: tap.id, ...(action && { action }) };
}

/** Four outstanding taps total, retained until accepted and receipted exactly once. */
export class TapQueue {
  private serial = 0;
  private pending: LifeTap[] = [];
  private sent = new Map<number, LifeTap>();
  add(tap: Omit<LifeTap, 'id'>) {
    if (this.pending.length + this.sent.size >= 4) return;
    this.pending.push({ ...tap, id: ++this.serial });
  }
  batch(generation: number | undefined) {
    this.pending = this.pending.filter((tap) => tap.generation === generation);
    for (const [id, tap] of this.sent) if (tap.generation !== generation) this.sent.delete(id);
    return this.pending.length ? this.pending : undefined;
  }
  accepted(batch: readonly LifeTap[] | undefined) {
    if (!batch) return;
    for (const tap of batch) this.sent.set(tap.id, tap);
    this.pending = this.pending.filter((tap) => !this.sent.has(tap.id));
  }
  consume(receipts: readonly TapReceipt[] | undefined, generation: number | undefined) {
    const chosen: { tap: LifeTap; action: TapAction }[] = [];
    for (const receipt of receipts ?? []) {
      const tap = this.sent.get(receipt.id);
      this.sent.delete(receipt.id);
      if (tap && tap.generation === generation && receipt.action)
        chosen.push({ tap, action: receipt.action });
    }
    return chosen;
  }
  clear() {
    this.pending.length = 0;
    this.sent.clear();
  }
}

/** Bounded presentation requests, including waves deferred until an utterance ends. */
export class TapReactions {
  private entries: { cue: EmojiRequest; at: number }[] = [];
  add(cue: EmojiRequest, at: number) {
    if (this.entries.length < 32) this.entries.push({ cue, at });
  }
  drain(clock: number, eligible: (owner: object) => boolean, speaking: (owner: object) => boolean) {
    const ready: EmojiRequest[] = [];
    this.entries = this.entries.filter(({ cue, at }) => {
      if (clock > cue.expires || !eligible(cue.owner)) return false;
      if (clock < at || speaking(cue.owner)) return true;
      ready.push({ ...cue, eligible: true, speaking: false });
      return false;
    });
    return ready;
  }
  clear() {
    this.entries.length = 0;
  }
}

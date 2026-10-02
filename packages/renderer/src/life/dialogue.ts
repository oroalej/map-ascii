/** Text-free, context-aware selection. Never consumes a population or movement RNG. */
import {
  greetingPeriod,
  dialogueDelivery,
  type DialogueAnchor,
  type DialogueChoice,
  type DialogueProfile,
  type GreetingPeriods,
} from '@atlas/shared';
import { random } from './random';

export type DialogueContext = {
  minutes: number;
  rain: number;
  wind: number;
  easing?: boolean;
  sheltered?: boolean;
  arrival?: boolean;
  place?: string;
  anchors?: readonly DialogueAnchor[];
  figures: readonly string[];
  profiles?: readonly DialogueProfile[];
  delivery?: DialogueChoice['delivery'];
};
export class DialogueMemory {
  readonly recent: string[] = [];
  private actors = new WeakMap<object, string[]>();
  private speechCooldown = new WeakMap<object, number>();
  private attempts = new WeakMap<object, number>();
  private outcomes: boolean[] = [];
  private expressionRng: () => number;
  private attemptRng: () => number;
  constructor(private readonly seed = 0) {
    this.expressionRng = random(seed ^ 0x31f253ab);
    this.attemptRng = random(seed ^ 0x673052a1);
  }
  ready(owners: readonly object[], at: number) {
    return owners.every((owner) => (this.speechCooldown.get(owner) ?? 0) <= at);
  }
  reserve(owners: readonly object[], until: number) {
    for (const owner of owners) this.speechCooldown.set(owner, until);
  }
  /** One attempt per simulation minute, including failed rolls and camera re-entry. */
  ambientAttempt(owner: object, at: number) {
    const epoch = Math.floor(at / 60);
    if (this.attempts.get(owner) === epoch) return false;
    this.attempts.set(owner, epoch);
    return this.attemptRng() < 0.25;
  }
  /** Legacy catalogs and functional exchanges retain their authored speaking turns. */
  voiced(entry: DialogueChoice) {
    if (entry.delivery !== 'utterance') return true;
    if (!this.outcomes.length) {
      this.outcomes = [true, true, false];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(this.expressionRng() * (i + 1));
        [this.outcomes[i], this.outcomes[j]] = [this.outcomes[j]!, this.outcomes[i]!];
      }
    }
    return this.outcomes.pop()!;
  }
  rank(id: string, owners: readonly object[]) {
    const recent = this.recent.lastIndexOf(id);
    return (
      (recent < 0 ? 0 : 4 + (recent + 1) / 9) +
      owners.reduce((n, owner) => {
        const age = this.actors.get(owner)?.lastIndexOf(id) ?? -1;
        return n + (age < 0 ? 0 : 1 + (age + 1) / 4);
      }, 0)
    );
  }
  remember(id: string, owners: readonly object[]) {
    this.recent.push(id);
    if (this.recent.length > 8) this.recent.shift();
    for (const owner of owners) {
      const history = this.actors.get(owner) ?? [];
      history.push(id);
      if (history.length > 3) history.shift();
      this.actors.set(owner, history);
    }
  }
  clear() {
    this.recent.length = 0;
    this.actors = new WeakMap();
    this.speechCooldown = new WeakMap();
    this.attempts = new WeakMap();
    this.outcomes = [];
    this.expressionRng = random(this.seed ^ 0x31f253ab);
    this.attemptRng = random(this.seed ^ 0x673052a1);
  }
}

const owned: readonly DialogueProfile[] = ['vendor-order', 'vendor-thanks', 'transit', 'companion'];
export function dialogueEligible(
  entry: DialogueChoice,
  c: DialogueContext,
  periods?: Readonly<GreetingPeriods>,
) {
  if (c.delivery && dialogueDelivery(entry) !== c.delivery) return false;
  if (dialogueDelivery(entry) === 'exchange' && c.figures.length < 2) return false;
  if (entry.kind === 'greet' && entry.period !== greetingPeriod(c.minutes, periods)) return false;
  if (entry.speakers?.some((slot) => slot >= c.figures.length)) return false;
  const p = entry.profile;
  if (c.profiles ? !p || !c.profiles.includes(p) : p && owned.includes(p)) return false;
  if (p === 'school' && c.place !== 'school') return false;
  if (p === 'daily-plans' && c.figures.some((f) => f === 'child')) return false;
  if (
    p === 'place-reaction' &&
    !c.anchors?.some((a) => ['monument', 'fountain', 'plaza'].includes(a))
  )
    return false;
  const q = entry.conditions;
  if (!q) return true;
  if (q.anchor && !c.anchors?.includes(q.anchor)) return false;
  if (q.audience === 'adults' && c.figures.some((f) => f === 'child')) return false;
  if (
    q.audience === 'adult-child' &&
    (!c.figures.includes('child') || !c.figures.includes('adult'))
  )
    return false;
  if (q.event === 'arrival' && !c.arrival) return false;
  switch (q.weather) {
    case 'daylight':
      return c.minutes >= 360 && c.minutes < 1080 && c.rain < 0.5;
    case 'calm':
      return c.wind < 0.4 && c.rain < 0.5;
    case 'breeze':
      return c.wind >= 0.4 && c.wind < 0.9 && c.rain < 0.5;
    case 'gust':
      return c.wind >= 0.9 && c.rain < 0.5;
    case 'rain':
      return !!c.sheltered && c.rain >= 0.5;
    case 'heavy-rain':
      return !!c.sheltered && c.rain >= 0.8;
    case 'easing':
      return !!c.sheltered && c.rain > 0.2 && !!c.easing;
    case 'evening-calm':
      return greetingPeriod(c.minutes, periods) === 'evening' && c.wind < 0.4 && c.rain < 0.5;
    default:
      return true;
  }
}

export class DialogueSelector {
  private readonly byKind = new Map<DialogueChoice['kind'], DialogueChoice[]>();
  private readonly bags = new Map<string, { remaining: DialogueChoice[]; last?: string }>();
  private readonly rng: () => number;
  readonly selected: Record<string, number> = {};
  constructor(
    seed: number,
    choices: readonly DialogueChoice[],
    private readonly periods?: Readonly<GreetingPeriods>,
    readonly memory = new DialogueMemory(seed),
  ) {
    this.rng = random(seed ^ 0x592cf6a3);
    for (const choice of choices) {
      const list = this.byKind.get(choice.kind) ?? [];
      list.push(choice);
      this.byKind.set(choice.kind, list);
    }
  }
  choose(
    kind: DialogueChoice['kind'],
    context: DialogueContext,
    owners: readonly object[],
    remember = true,
  ) {
    const choices = (this.byKind.get(kind) ?? []).filter((e) =>
      dialogueEligible(e, context, this.periods),
    );
    if (!choices.length) return;
    const key = choices.map((e) => e.id).join('|');
    let bag = this.bags.get(key);
    if (!bag) {
      if (this.bags.size >= 64) this.bags.delete(this.bags.keys().next().value!);
      bag = { remaining: [] };
      this.bags.set(key, bag);
    }
    if (!bag.remaining.length) {
      bag.remaining = [...choices];
      for (let i = bag.remaining.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [bag.remaining[i], bag.remaining[j]] = [bag.remaining[j]!, bag.remaining[i]!];
      }
    }
    let best = 0,
      rank = Infinity;
    for (let i = 0; i < bag.remaining.length; i++) {
      const e = bag.remaining[i]!;
      const score =
        this.memory.rank(e.id, owners) + (e.id === bag.last && bag.remaining.length > 1 ? 100 : 0);
      if (score < rank) {
        best = i;
        rank = score;
      }
    }
    const [entry] = bag.remaining.splice(best, 1);
    bag.last = entry!.id;
    if (remember) this.admit(entry!, owners);
    return entry;
  }
  /** Commit history only after physical and service-lifetime admission succeeds. */
  admit(entry: DialogueChoice, owners: readonly object[]) {
    this.memory.remember(entry.id, owners);
    this.selected[entry.id] = (this.selected[entry.id] ?? 0) + 1;
  }
  clear() {
    this.bags.clear();
  }
}

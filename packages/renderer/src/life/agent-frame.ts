import type { VisibleAgent } from './simulate';

/**
 * The worker's visible agents as transferable columns (ARCHITECTURE.md §6 "Packed Life
 * frames"). Scalar fields travel in typed arrays; strings through a per-frame table; every
 * other own property (nested looks, cues, lines) in a sparse sidecar, so the frame stays
 * lossless as fields are added. Each decode creates fresh objects: an accepted frame is never
 * mutated afterwards, so anything may retain it.
 */
export type PackedAgents = {
  count: number;
  /** `NUMBER_FIELDS` then `ahead` and `side` (two each), per agent. */
  numbers: Float64Array;
  /** Per agent: one presence bit per field, then the values of `BOOLEAN_FIELDS`. */
  present: Uint32Array;
  /** `STRING_FIELDS` per agent, as indices into `table`. */
  strings: Uint16Array;
  table: string[];
  /** Per agent: its `extras` entry, or -1. */
  extra: Int32Array;
  extras: Record<string, unknown>[];
};

const NUMBER_FIELDS = [
  'lng',
  'lat',
  'flap',
  'paint',
  'effectClock',
  'candleSeed',
  'inspectionId',
  'stroke',
] as const;
const PAIR_FIELDS = ['ahead', 'side'] as const;
const STRING_FIELDS = ['kind', 'vehicle', 'prop', 'eventGround', 'eventRole', 'glyph'] as const;
const BOOLEAN_FIELDS = [
  'mappedPersonMover',
  'event',
  'covered',
  'parked',
  'candle',
  'aboard',
  'eventScenery',
] as const;
const NUMBERS = NUMBER_FIELDS.length + PAIR_FIELDS.length * 2;
const STRINGS = STRING_FIELDS.length;
/** Presence bits: numbers, pairs, strings, booleans; boolean values follow. */
const PAIR_BIT = NUMBER_FIELDS.length;
const STRING_BIT = PAIR_BIT + PAIR_FIELDS.length;
const BOOLEAN_BIT = STRING_BIT + STRINGS;
const VALUE_BIT = BOOLEAN_BIT + BOOLEAN_FIELDS.length;
if (VALUE_BIT + BOOLEAN_FIELDS.length > 32) throw new Error('Packed agent flags exceed 32 bits');
const MAX_STRINGS = 0xffff;

type Slot = { kind: 'number' | 'pair' | 'string' | 'boolean'; index: number };
const slots = new Map<string, Slot>([
  ...NUMBER_FIELDS.map((key, index): [string, Slot] => [key, { kind: 'number', index }]),
  ...PAIR_FIELDS.map((key, index): [string, Slot] => [key, { kind: 'pair', index }]),
  ...STRING_FIELDS.map((key, index): [string, Slot] => [key, { kind: 'string', index }]),
  ...BOOLEAN_FIELDS.map((key, index): [string, Slot] => [key, { kind: 'boolean', index }]),
]);

const isPair = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number';

/** Pack `agents`, every own property included. */
export function packAgents(agents: readonly VisibleAgent[]): PackedAgents {
  const count = agents.length;
  const numbers = new Float64Array(count * NUMBERS);
  const present = new Uint32Array(count);
  const strings = new Uint16Array(count * STRINGS);
  const extra = new Int32Array(count).fill(-1);
  const table: string[] = [];
  const indices = new Map<string, number>();
  const extras: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    const agent = agents[i]! as unknown as Record<string, unknown>;
    let bits = 0;
    let rest: Record<string, unknown> | undefined;
    for (const key of Object.keys(agent)) {
      const value = agent[key];
      const slot = slots.get(key);
      if (slot?.kind === 'number' && typeof value === 'number') {
        numbers[i * NUMBERS + slot.index] = value;
        bits |= 1 << slot.index;
        continue;
      }
      if (slot?.kind === 'pair' && isPair(value)) {
        const at = i * NUMBERS + NUMBER_FIELDS.length + slot.index * 2;
        numbers[at] = value[0];
        numbers[at + 1] = value[1];
        bits |= 1 << (PAIR_BIT + slot.index);
        continue;
      }
      if (slot?.kind === 'string' && typeof value === 'string') {
        let index = indices.get(value);
        if (index === undefined && table.length < MAX_STRINGS) {
          index = table.push(value) - 1;
          indices.set(value, index);
        }
        if (index !== undefined) {
          strings[i * STRINGS + slot.index] = index;
          bits |= 1 << (STRING_BIT + slot.index);
          continue;
        }
      }
      if (slot?.kind === 'boolean' && typeof value === 'boolean') {
        bits |= 1 << (BOOLEAN_BIT + slot.index);
        if (value) bits |= 1 << (VALUE_BIT + slot.index);
        continue;
      }
      (rest ??= {})[key] = value;
    }
    present[i] = bits >>> 0;
    if (rest) extra[i] = extras.push(rest) - 1;
  }
  return { count, numbers, present, strings, table, extra, extras };
}

/** The buffers a reply transfers instead of copying. */
export const packedTransferables = (packed: PackedAgents): ArrayBuffer[] => [
  packed.numbers.buffer as ArrayBuffer,
  packed.present.buffer as ArrayBuffer,
  packed.strings.buffer as ArrayBuffer,
  packed.extra.buffer as ArrayBuffer,
];

/** Fresh agents for an accepted reply; absent fields stay absent. */
export function unpackAgents(packed: PackedAgents): VisibleAgent[] {
  const { count, numbers, present, strings, table, extra, extras } = packed;
  const agents = new Array<VisibleAgent>(count);
  for (let i = 0; i < count; i++) {
    const bits = present[i]!;
    const agent: Record<string, unknown> = {};
    for (let s = 0; s < STRINGS; s++)
      if (bits & (1 << (STRING_BIT + s)))
        agent[STRING_FIELDS[s]!] = table[strings[i * STRINGS + s]!];
    for (let n = 0; n < NUMBER_FIELDS.length; n++)
      if (bits & (1 << n)) agent[NUMBER_FIELDS[n]!] = numbers[i * NUMBERS + n];
    for (let p = 0; p < PAIR_FIELDS.length; p++)
      if (bits & (1 << (PAIR_BIT + p))) {
        const at = i * NUMBERS + NUMBER_FIELDS.length + p * 2;
        agent[PAIR_FIELDS[p]!] = [numbers[at], numbers[at + 1]];
      }
    for (let b = 0; b < BOOLEAN_FIELDS.length; b++)
      if (bits & (1 << (BOOLEAN_BIT + b)))
        agent[BOOLEAN_FIELDS[b]!] = (bits & (1 << (VALUE_BIT + b))) !== 0;
    const rest = extra[i]!;
    if (rest >= 0) Object.assign(agent, extras[rest]);
    agents[i] = agent as unknown as VisibleAgent;
  }
  return agents;
}

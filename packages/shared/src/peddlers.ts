import type { Source } from './schemas';

const PUBLIC_ACCESS = new Set(['yes', 'public', 'permissive', 'designated']);
/** Permission to walk through a property does not permit generated street vendors there. */
export function vendorAccessRestricted(tags: Readonly<Record<string, unknown>>): boolean {
  const restricted = (value: unknown) =>
    value !== undefined && value !== '' && (typeof value !== 'string' || !PUBLIC_ACCESS.has(value));
  return (
    tags.ownership === 'private' ||
    restricted(tags.access) ||
    (tags.foot !== 'use_sidepath' && restricted(tags.foot))
  );
}

/** Generic carried shapes; goods, labels and illustrative hours belong to city packs. */
export const PEDDLER_PROPS = [
  'pole-buckets',
  'basket',
  'head-tray',
  'chest-tray',
  'box-cart',
  'fry-cart',
  'flatbed-cart',
] as const;
export type PeddlerProp = (typeof PEDDLER_PROPS)[number];
export type PeddlerHours = { from: number; to: number };
export type PeddlerConfig = {
  id: string;
  label: string;
  prop: PeddlerProp;
  hours: PeddlerHours | PeddlerHours[];
  lines: ('street' | 'path' | 'plaza')[];
  perTile: 1 | 2;
  share?: number;
  call?: 'voice' | 'bell';
  weather?: { rain?: number; heat?: number; wind?: number };
  near?: { kind: 'stop' | 'terminal'; reach: number };
  lamp?: boolean;
  emoji?: { heat?: 'cool' };
  source: Source[];
};

/** Splits wrapping intervals for validation without conflating 24:00 with 00:00. */
export function peddlerHourParts(hours: PeddlerHours): [number, number][] {
  return hours.from < hours.to
    ? [[hours.from, hours.to]]
    : [
        [hours.from, 24],
        [0, hours.to],
      ];
}

import * as z from 'zod';
import { SignalArm, SignalPosition } from './signal-layout';
import { lngLatToTile, MERCATOR_METERS, TILE_EXTENT } from './tile-space';

export const ControllerSeed = z.number().int().min(0).max(0xffffffff);
export const CrossingController = z.strictObject({
  id: z.string().min(1),
  at: SignalPosition,
  seed: ControllerSeed,
  midBlock: z.boolean(),
  walk: z.enum(['a', 'b']),
});
export type CrossingController = z.infer<typeof CrossingController>;

/** Exact paint centres and inbound tangents, also used by legacy vehicle control. */
export const SignalStops = z.array(
  SignalArm.refine(
    (arm) => !!arm.stop && arm.stop_width !== undefined && arm.stop_bearing !== undefined,
    {
      message: 'exact stops require position, width and local inbound bearing',
    },
  ),
);
export type SignalStops = z.infer<typeof SignalStops>;

/** Match the existing placeSeed hash at the highest source zoom, before MVT quantization. */
export function canonicalSignalSeed(lng: number, lat: number, maxZoom: number): number {
  const p = lngLatToTile({ z: maxZoom, x: 0, y: 0 }, lng, lat);
  const scale = MERCATOR_METERS / (2 ** maxZoom * TILE_EXTENT);
  const x = Math.round(Math.round(p.x) * scale) | 0;
  const y = Math.round(Math.round(p.y) * scale) | 0;
  return (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841)) >>> 0;
}

const crossingKeys = [
  'crossing_signal',
  'crossing_signal_at',
  'crossing_signal_seed',
  'crossing_mid',
  'crossing_walk',
] as const;

/** MVT properties are scalars. Partial tags are errors, rather than unsignalized crossings. */
export function decodeCrossingController(
  properties: Readonly<Record<string, unknown>>,
): CrossingController | undefined {
  if (!crossingKeys.some((key) => properties[key] !== undefined)) return;
  if (typeof properties.crossing_signal_at !== 'string')
    throw new Error('crossing_signal_at must be scalar JSON');
  return CrossingController.parse({
    id: properties.crossing_signal,
    at: JSON.parse(properties.crossing_signal_at),
    seed: properties.crossing_signal_seed,
    midBlock: properties.crossing_mid ?? false,
    walk: properties.crossing_walk,
  });
}

export function crossingControllerProperties(controller: CrossingController) {
  const c = CrossingController.parse(controller);
  return {
    crossing_signal: c.id,
    crossing_signal_at: JSON.stringify(c.at),
    crossing_signal_seed: c.seed,
    ...(c.midBlock ? { crossing_mid: true as const } : {}),
    crossing_walk: c.walk,
  };
}

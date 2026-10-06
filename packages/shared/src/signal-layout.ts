import * as z from 'zod';

export const SignalPosition = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** Exterior arms, resolved on complete roads after city direction overrides. */
export const SignalArm = z
  .strictObject({
    road_id: z.string().min(1),
    junction: SignalPosition,
    toward: SignalPosition,
    direction: z.union([z.literal(-1), z.literal(1)]),
    inbound: z.boolean(),
    outbound: z.boolean(),
    group: z.enum(['a', 'b']),
    bearing: z.number().min(0).lt(360),
    width: z.number().positive(),
    stop: SignalPosition.optional(),
    stop_width: z.number().positive().optional(),
    stop_bearing: z.number().min(0).lt(360).optional(),
    stop_road_id: z.string().min(1).optional(),
    stop_direction: z.union([z.literal(-1), z.literal(1)]).optional(),
    stop_road_width: z.number().positive().optional(),
  })
  .refine(
    (arm) =>
      !!arm.stop === (arm.stop_width !== undefined) &&
      (!arm.stop || arm.inbound) &&
      (arm.stop_bearing === undefined || !!arm.stop) &&
      (arm.stop_road_id === undefined
        ? arm.stop_direction === undefined && arm.stop_road_width === undefined
        : !!arm.stop && arm.stop_direction !== undefined && arm.stop_road_width !== undefined),
    {
      message:
        'inbound stops require position and width; optional local bearing and complete stop-road identity require a stop',
    },
  );
export type SignalArm = z.infer<typeof SignalArm>;

export const SignalLayout = z.strictObject({
  members: z.array(SignalPosition).min(1),
  arms: z.array(SignalArm),
});
export type SignalLayout = z.infer<typeof SignalLayout>;

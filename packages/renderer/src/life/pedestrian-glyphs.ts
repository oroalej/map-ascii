/** Import-free appended atlas slots and low-six-bit hardware parts. */
export const PED_STOP = '\ue229';
export const PED_WALK = '\ue22a';
export const PEDESTRIAN_GLYPHS = [PED_STOP, PED_WALK] as const;
export const PedestrianPart = { stop: 47, walk: 48 } as const;

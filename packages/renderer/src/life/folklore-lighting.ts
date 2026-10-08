import { FOLKLORE } from './folklore-config';

const middle = (FOLKLORE.hauntDim + FOLKLORE.hauntBright) / 2,
  amplitude = (FOLKLORE.hauntBright - FOLKLORE.hauntDim) / 2,
  angularFrequency = Math.PI * 2 * FOLKLORE.hauntFrequency;

/** CPU reference for the entire profile, including its brightest phase. */
export const hauntLampBrightness = (time: number, lampByte: number) =>
  middle + amplitude * Math.cos(time * angularFrequency + (lampByte >> 3) * 0.37);

export const hauntLampGlsl = `
float hauntLamp(float time, int lampByte) {
  return ${middle} + ${amplitude} * cos(time * ${angularFrequency} + float(lampByte >> 3) * 0.37);
}
`;

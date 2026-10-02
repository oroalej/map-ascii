import { describe, expect, it, vi } from 'vitest';
import type { CellTargets, GL } from './gpu';
import type * as GpuModule from './gpu';
import { uploadLights } from './gpu';
import type { ThemeResources } from './gpu-context';
import { lifePass, lightPass, type View, type GridPlacement } from './passes';
import { buildLifeGlyphs } from './life/draw';
import { BRAKE_POOL } from './life/lamps';
import { LampState, lightByte } from './life/lights';
import type { VisibleAgent } from './life/simulate';
import { themes } from './theme';

vi.mock('./gpu', async (load) => ({
  ...(await load<typeof GpuModule>()),
  uploadLife: vi.fn(),
  uploadLights: vi.fn(),
}));

// These CPU passes upload through mocked GL helpers; only target dimensions are consumed.
const targets = (cols = 128) => ({ cols, rows: 96 }) as CellTargets;
const gl = {} as GL;
const resources = {
  map: { atlas: { index: () => 1 }, lifeGlyphs: buildLifeGlyphs(() => 1) },
} as unknown as ThemeResources;
const placement: GridPlacement = {
  grid: { originCol: 0, originRow: 0, shiftX: 0, shiftY: 0 },
  tileMatrix: () => [],
  toCell: (x, y) => [x * 2, y],
};
const view: View = {
  camera: { lng: 0, lat: 0, zoom: 20 },
  dpr: 1,
  cellDev: { w: 6, h: 12 },
  labelDev: { w: 6, h: 12 },
  detailZoom: 20,
  width: 768,
  height: 1152,
};
const braking = (): VisibleAgent => ({
  kind: 'vehicle',
  vehicle: 'car',
  lng: 32,
  lat: 48,
  ahead: [33, 48],
  side: [32, 49],
  paint: 0,
  flap: 0,
  lamps: { kind: 'brake' },
});
const uploaded = () => vi.mocked(uploadLights).mock.calls.at(-1)![2];
const hasGlow = () => {
  const texels = uploaded();
  for (let at = 0; at < texels.length; at += 4)
    if (texels[at] && texels[at + 1] === lightByte(LampState.beam, BRAKE_POOL.seed)) return true;
  return false;
};
const paint = (target: CellTargets, agents: VisibleAgent[], allowed = true) =>
  lifePass(
    gl,
    target,
    resources,
    themes.dark,
    view,
    placement,
    agents,
    undefined,
    undefined,
    () => allowed,
  );
const light = (target: CellTargets, agents: VisibleAgent[]) =>
  lightPass(gl, target, view, placement, [], agents, true);

describe('brake glow pass composition', () => {
  it('pairs source stamps to their current agent batch and clears rejected or released brakes', () => {
    const target = targets(),
      actors = [braking()];
    paint(target, actors);
    light(target, actors);
    expect(hasGlow()).toBe(true);
    light(target, [...actors]);
    expect(hasGlow()).toBe(false);
    paint(target, actors, false);
    light(target, actors);
    expect(hasGlow()).toBe(false);
    const released = [{ ...actors[0]!, lamps: undefined }];
    paint(target, released);
    light(target, released);
    expect(hasGlow()).toBe(false);
  });

  it('keeps map targets independent and clears when Life/daytime/beam quality supplies no actors', () => {
    const first = targets(),
      other = targets(),
      actors = [braking()];
    paint(first, actors);
    light(first, actors);
    expect(hasGlow()).toBe(true);
    light(other, actors);
    expect(hasGlow()).toBe(false);
    light(first, []);
    expect(uploaded().some(Boolean)).toBe(false);
    const empty: VisibleAgent[] = [];
    paint(first, empty);
    light(first, empty);
    expect(uploaded().some(Boolean)).toBe(false);
    const resized = targets(120);
    paint(resized, actors);
    light(resized, actors);
    expect(hasGlow()).toBe(true);
    expect(uploaded().length).toBe(120 * 96 * 4);
  });
});

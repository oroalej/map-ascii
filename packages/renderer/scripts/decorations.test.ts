import { expect, it } from 'vitest';
import { withoutDecorations } from './decorations';

it('excludes tile decorations while retaining equally named movement and scene data', () => {
  const state = {
    tiles: [
      {
        decorations: { puffs: [1] },
        movers: [{ brake: 2, exhaust: 3 }],
        scene: { decorations: 4 },
      },
    ],
    retired: [{ decorations: { effects: [1] }, pending: [{ puffs: 5 }] }],
    clock: 1,
  };
  expect(withoutDecorations(state)).toEqual({
    tiles: [{ movers: [{ brake: 2, exhaust: 3 }], scene: { decorations: 4 } }],
    retired: [{ pending: [{ puffs: 5 }] }],
    clock: 1,
  });
  expect(state.tiles[0]!.decorations).toEqual({ puffs: [1] });
});

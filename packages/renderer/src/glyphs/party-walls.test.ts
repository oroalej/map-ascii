import { expect, it } from 'vitest';
import { partySeam, partyWallMask, type WallCell } from './party-walls';
import { wallGlyph, wallMask } from './select';

function draw(rows: string[], ids = (id: number) => id) {
  const sample = (x: number, y: number): WallCell => ({
    id: ids(Number(rows[y]?.[x] ?? 0)),
    eligible: !!Number(rows[y]?.[x]),
    height: Number(rows[y]?.[x]) ? 6 : 0,
    style: 1,
  });
  return rows.map((r, y) =>
    [...r]
      .map((id, x) => {
        if (id === '0') return ' ';
        const party = partyWallMask((dx, dy) => sample(x + dx, y + dy));
        const mask =
          party === undefined
            ? wallMask((dx, dy) => sample(x + dx, y + dy).id !== ids(Number(id)))
            : party;
        return mask === null ? ' ' : wallGlyph('single', mask);
      })
      .join(''),
  );
}
it('draws one stable wall with joined endpoints between boxes regardless of arrival order', () => {
  const rows = ['1111222', '1111222', '1111222'];
  expect(draw(rows)).toEqual(['┌──┬──┐', '│  │  │', '└──┴──┘']);
  expect(draw(rows, (n) => (n ? 100 - n : 0))).toEqual(draw(rows));
  expect(draw(['1111222333', '1111222333', '1111222333'])).toEqual([
    '┌──┬──┬──┐',
    '│  │  │  │',
    '└──┴──┴──┘',
  ]);
});
it('joins horizontal party walls and preserves corner-only contact', () => {
  expect(draw(['11111', '11111', '11111', '22222', '22222'])).toEqual([
    '┌───┐',
    '│   │',
    '├───┤',
    '│   │',
    '└───┘',
  ]);
  expect(
    partyWallMask((x, y) => ({
      id: x === 0 && y === 0 ? 1 : x === 1 && y === 1 ? 2 : 0,
      eligible: x === y && x >= 0 && x <= 1,
      height: 6,
      style: 1,
    })),
  ).toBeUndefined();
});
it('does not merge heights or styles, or darken a seam twice', () => {
  const center: WallCell = { id: 1, height: 6, eligible: true, style: 1 };
  expect(partySeam(center, { ...center, id: 2 }, { ...center, id: 3 })).toBe(false);
  const unoutlined = { ...center, style: 0 };
  expect(partySeam(unoutlined, { ...unoutlined, id: 2 }, unoutlined)).toBe(true);
  expect(partySeam(unoutlined, { ...unoutlined, id: 2, landmark: true }, unoutlined)).toBe(false);
  expect(partySeam(unoutlined, { ...unoutlined, id: 2, style: 1 }, unoutlined)).toBe(false);
  expect(partySeam(unoutlined, unoutlined, unoutlined)).toBe(false);
  expect(partySeam(center, { ...center, id: 2, height: 12 }, center)).toBe(false);
  expect(partySeam(center, { ...center, id: 2, style: 2 }, center)).toBe(false);
  expect(
    partyWallMask((x, y) => (x === 0 && y === 0 ? center : { ...center, id: 2, style: 2 })),
  ).toBeUndefined();
});

it('joins a three-building T without a doubled vertical seam', () => {
  expect(draw(['1111222', '1111222', '1111333', '1111333', '1111333'])).toEqual([
    '┌──┬──┐',
    '│  ├──┤',
    '│  │  │',
    '│  │  │',
    '└──┴──┘',
  ]);
});

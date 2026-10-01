import { expect, it } from 'vitest';
import { sameReferenceMembers } from './cache-inputs';

it('compares reference multiplicity without depending on traversal order', () => {
  const a = {},
    b = {},
    replacement = {};
  expect(sameReferenceMembers([a, b, a], [b, a, a])).toBe(true);
  expect(sameReferenceMembers([a, a, b], [a, b, b])).toBe(false);
  expect(sameReferenceMembers([a, b], [a, replacement])).toBe(false);
  expect(sameReferenceMembers([a, b], [a])).toBe(false);
  expect(sameReferenceMembers([], [])).toBe(true);
});

import { describe, expect, it } from 'vitest';
import { foldTerm } from './search-options';

describe('foldTerm', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldTerm('Peñafrancia')).toBe('penafrancia');
  });

  it('spells out compatibility characters, so "II" finds "Ⅱ"', () => {
    expect(foldTerm('Ⅱ')).toBe(foldTerm('II'));
    expect(foldTerm('Ⅲ')).toBe('iii');
  });
});

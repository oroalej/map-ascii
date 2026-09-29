import { describe, expect, it } from 'vitest';
import { cacheAnswers } from './overpass';

const q = (bbox: string, filter = 'way["highway"];') =>
  `[out:json][timeout:300][bbox:${bbox}];\n${filter}\nout body;`;
const city = q('13.5,123.1,13.7,123.4');
const downtown = q('13.602,123.17,13.64,123.213');

describe('cacheAnswers', () => {
  const online = { offline: false };

  it('keeps a saved download for the same query, however old', () => {
    expect(cacheAnswers(city, city, online)).toBe(true);
  });

  it('answers a smaller bbox from a saved larger one with the same filters', () => {
    expect(cacheAnswers(city, downtown, online)).toBe(true);
  });

  it('downloads when the bbox reaches outside the saved one, or the filters changed', () => {
    expect(cacheAnswers(downtown, city, online)).toBe(false);
    expect(cacheAnswers(city, q('13.602,123.17,13.64,123.213', 'way["building"];'), online)).toBe(
      false,
    );
    expect(cacheAnswers('rel(1);\nout;', 'rel(2);\nout;', online)).toBe(false);
    expect(cacheAnswers(undefined, city, online)).toBe(false);
  });

  it('downloads again on refresh', () => {
    expect(cacheAnswers(city, city, { offline: false, refresh: true })).toBe(false);
  });

  it('always uses the saved download offline', () => {
    expect(cacheAnswers('old', city, { offline: true })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { dialogueCatalog } from './dialogue';
import { dialogueChoices, greetingPeriod } from './dialogue-options';

const catalog = {
  native: { code: 'bcl', label: 'Bikol' },
  translations: [
    { code: 'en', label: 'English' },
    { code: 'fil', label: 'Tagalog' },
  ],
  exchanges: [
    {
      id: 'hello',
      kind: 'greet',
      period: 'morning',
      lines: [
        { en: 'Good morning!', bcl: 'Marhay na aga!', fil: 'Magandang umaga!' },
        { en: 'Good morning!', bcl: 'Marhay na aga!', fil: 'Magandang umaga!' },
      ],
      sources: [{ title: 'Phrase reference', url: 'https://example.org/reference' }],
    },
  ],
};
describe('curated dialogue', () => {
  const schema = dialogueCatalog(['bcl', 'fil']);
  it('validates complete translations and compiles only text-free worker choices', () => {
    const parsed = schema.parse(catalog);
    expect(dialogueChoices(parsed)).toEqual([
      { id: 'hello', kind: 'greet', period: 'morning', turns: 2 },
    ]);
  });
  it('rejects incomplete/undeclared languages, duplicate ids, missing sources and malformed turns', () => {
    const missing = structuredClone(catalog);
    Reflect.deleteProperty(missing.exchanges[0]!.lines[0]!, 'fil');
    expect(schema.safeParse(missing).success).toBe(false);
    expect(dialogueCatalog(['fil']).safeParse(catalog).success).toBe(false);
    expect(
      schema.safeParse({ ...catalog, translations: [...catalog.translations, catalog.native] })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...catalog, exchanges: [...catalog.exchanges, ...catalog.exchanges] })
        .success,
    ).toBe(false);
    for (const changes of [
      { sources: [] },
      { lines: [] },
      { period: undefined },
      { kind: 'look' },
      { lines: [{ en: 'Hi\nthere', bcl: 'Hi', fil: 'Hi' }, catalog.exchanges[0]!.lines[1]] },
    ])
      expect(
        schema.safeParse({ ...catalog, exchanges: [{ ...catalog.exchanges[0], ...changes }] })
          .success,
      ).toBe(false);
  });
  it.each([
    [0, 'evening'],
    [299, 'evening'],
    [300, 'morning'],
    [719, 'morning'],
    [720, 'afternoon'],
    [1079, 'afternoon'],
    [1080, 'evening'],
    [1439, 'evening'],
  ])('selects the local greeting at minute %s', (minutes, period) => {
    expect(greetingPeriod(minutes)).toBe(period);
  });
});

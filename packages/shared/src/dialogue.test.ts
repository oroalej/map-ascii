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
  it('keeps role and scene metadata in text-free choices and rejects mismatched contracts', () => {
    const entry = { ...catalog.exchanges[0], profile: 'greeting', speakers: [0, 1] };
    const valid = schema.parse({ ...catalog, exchanges: [entry] });
    expect(dialogueChoices(valid)[0]).toMatchObject({ profile: 'greeting', speakers: [0, 1] });
    for (const change of [
      { speakers: [0, 0] },
      { speakers: [0, 2] },
      { speakers: undefined },
      { profile: 'vendor-order' },
      { conditions: { event: 'catch' } },
      { conditions: { audience: 'adult-child' } },
    ])
      expect(schema.safeParse({ ...catalog, exchanges: [{ ...entry, ...change }] }).success).toBe(
        false,
      );
  });
  it('supports ordered city-local greeting boundaries and rejects malformed schedules', () => {
    const periods = { morningStart: 360, afternoonStart: 780, eveningStart: 1140 };
    expect(schema.parse({ ...catalog, periods }).periods).toEqual(periods);
    for (const [minutes, expected] of [
      [359, 'evening'],
      [360, 'morning'],
      [779, 'morning'],
      [780, 'afternoon'],
      [1139, 'afternoon'],
      [1140, 'evening'],
      [0, 'evening'],
    ] as const)
      expect(greetingPeriod(minutes, periods)).toBe(expected);
    for (const changes of [
      { morningStart: -1 },
      { morningStart: 1.5 },
      { afternoonStart: 360 },
      { eveningStart: 1440 },
      { extra: 1 },
    ])
      expect(schema.safeParse({ ...catalog, periods: { ...periods, ...changes } }).success).toBe(
        false,
      );
  });
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

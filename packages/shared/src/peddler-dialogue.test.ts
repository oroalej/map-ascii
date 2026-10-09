import { expect, it } from 'vitest';
import { dialogueCatalog, RuntimeDialogueCatalog, DialogueChoice } from './dialogue';
const entry = {
  id: 'call',
  kind: 'talk',
  profile: 'peddler-call',
  delivery: 'utterance',
  speakers: [0],
  lines: [{ en: 'Call!', bcl: 'Call!', fil: 'Call!' }],
  sources: [{ title: 'Original composition' }],
};
const pack = {
  native: { code: 'bcl', label: 'Bikol' },
  translations: [
    { code: 'en', label: 'English' },
    { code: 'fil', label: 'Tagalog' },
  ],
  exchanges: [entry],
};
it('validates peddler-only metadata in full, runtime and text-free catalogs', () => {
  const schema = dialogueCatalog(['bcl', 'fil']);
  expect(schema.safeParse(pack).success).toBe(true);
  for (const patch of [
    { kind: 'look' },
    { delivery: undefined },
    { delivery: 'exchange' },
    { speakers: [1] },
    { lines: [entry.lines[0], entry.lines[0]] },
    { conditions: { goods: [] } },
    { conditions: { goods: ['a', 'a'] } },
    { conditions: { goods: ['Bad id'] } },
    { conditions: { event: 'arrival' } },
    { conditions: { weather: 'gust' } },
  ]) {
    expect(
      schema.safeParse({ ...pack, exchanges: [{ ...entry, ...patch }] }).success,
      JSON.stringify(patch),
    ).toBe(false);
  }
  for (const conditions of [
    { goods: ['new-goods'] },
    { event: 'hover' },
    { event: 'leaving' },
    { weather: 'heat' },
    { weather: 'rain' },
    { weather: 'clearing' },
  ]) {
    expect(schema.safeParse({ ...pack, exchanges: [{ ...entry, conditions }] }).success).toBe(true);
    expect(
      schema.safeParse({ ...pack, exchanges: [{ ...entry, profile: 'courtesy', conditions }] })
        .success,
    ).toBe(!('goods' in conditions || 'event' in conditions));
  }
  const { sources: _sources, ...runtime } = entry;
  expect(
    RuntimeDialogueCatalog.safeParse({ ...pack, exchanges: [{ ...runtime, speakers: [1] }] })
      .success,
  ).toBe(false);
  expect(DialogueChoice.safeParse({ ...runtime, turns: 1, speakers: [1] }).success).toBe(false);
});

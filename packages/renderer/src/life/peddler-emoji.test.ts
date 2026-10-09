import { expect, it } from 'vitest';
import {
  ambientPool,
  PeddlerEmojiObserver,
  type EmojiObservation,
  type PeddlerObservation,
} from './emoji';
import { peddlerFixture, peddlerWeather } from './testing/peddlers';
const metadata: PeddlerObservation = {
  goods: 'unrelated-goods',
  cart: true,
  call: 'voice',
  progress: 0.8,
  elapsed: 30,
  dawn: true,
  wrappingNight: false,
  leaving: false,
  umbrella: false,
  shade: false,
  shelter: false,
  waitingNear: false,
  sinceCall: 100,
  callToken: 0,
  resumeToken: 0,
  hover: false,
};
function input(): EmojiObservation {
  const { population } = peddlerFixture();
  population.step(0, peddlerWeather, 0);
  return {
    owner: population.owners[0]!,
    subject: 'person',
    eligible: true,
    speaking: false,
    peddler: { ...metadata },
  };
}
it('uses generic pack-driven pools and realized cover, with no incompatible generic entries', () => {
  const o = input(),
    env = { ...peddlerWeather, minutes: 780, sunAltitude: 60, windPreset: 'gusty' as const };
  expect(ambientPool(o, env).map((p) => p.mood)).toEqual(
    expect.arrayContaining(['tired', 'working', 'hot', 'melting', 'windy', 'yawn', 'bored']),
  );
  o.peddler!.heat = 'cool';
  expect(ambientPool(o, env).map((p) => p.mood)).toContain('cool');
  expect(ambientPool(o, env).map((p) => p.mood)).not.toContain('hot');
  o.peddler!.umbrella = true;
  expect(ambientPool(o, { ...env, rain: 0.7 }).map((p) => p.mood)).not.toContain('rained');
  o.peddler!.umbrella = false;
  expect(ambientPool(o, { ...env, rain: 0.7 }).map((p) => p.mood)).toContain('sneeze');
});
it('latches exactly one post-call bell or wave, keeps event cooldown separate, and discards stale events', () => {
  const o = input(),
    owner = o.owner as ReturnType<typeof peddlerFixture>['population']['owners'][number],
    observer = new PeddlerEmojiObserver();
  observer.step(0, peddlerWeather, [o]);
  o.speaking = true;
  o.peddler!.call = 'bell';
  o.peddler!.hover = true;
  o.peddler!.callToken++;
  observer.step(1, peddlerWeather, [o]);
  expect(observer.cue(owner)).toBeUndefined();
  o.speaking = false;
  observer.step(3, peddlerWeather, [o]);
  expect(observer.cue(owner)?.mood).toBe('bell');
  observer.step(4, peddlerWeather, [o]);
  expect(observer.cue(owner)).toBeUndefined();
  o.peddler!.call = 'voice';
  o.peddler!.callToken++;
  observer.step(1, peddlerWeather, [o]);
  expect(observer.cue(owner)?.mood).toBe('wave');
  o.speaking = true;
  o.peddler!.callToken++;
  observer.step(1, peddlerWeather, [o]);
  observer.step(0, peddlerWeather, []);
  o.speaking = false;
  observer.step(4, peddlerWeather, [o]);
  expect(observer.cue(owner)).toBeUndefined();
  o.peddler!.resumeToken++;
  observer.step(1, peddlerWeather, [o]);
  expect(observer.cue(owner)?.mood).toBe('happy');
  observer.clear();
  expect(observer.cue(owner)).toBeUndefined();
});

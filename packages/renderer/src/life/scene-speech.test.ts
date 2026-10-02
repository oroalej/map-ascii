import { describe, expect, it } from 'vitest';
import { SCENE_SPEECH_CAPACITY, SceneSpeech, type SceneExchange } from './scene-speech';
import type { DialogueChoice } from '@atlas/shared';

const vendor: DialogueChoice = {
  id: 'order',
  kind: 'talk',
  profile: 'vendor-order',
  turns: 2,
  speakers: [0, 1],
};
function fixture(choice = vendor) {
  const a = {},
    b = {},
    state = { valid: true };
  const scenes = new SceneSpeech(1, [choice]);
  const scene: SceneExchange = {
    key: {},
    speakers: [
      { owner: a, member: 0, figure: 'adult' },
      { owner: b, member: 0, figure: 'adult' },
    ],
    profiles: [choice.profile!],
    context: { minutes: 720, rain: 0, wind: 0, figures: [] },
    remaining: 3,
    valid: () => state.valid,
  };
  return { a, b, state, scenes, scene };
}
describe('scene-owned dialogue', () => {
  it.each([
    [true, 0.2],
    [false, 0.2],
    [true, 20],
    [false, 20],
  ] as const)(
    'keeps service speech available after voiced=%s background at %s seconds',
    (voiced, at) => {
      const ambient: DialogueChoice = {
        id: 'happy',
        kind: 'talk',
        profile: 'daily-plans',
        delivery: 'utterance',
        turns: 1,
        speakers: [0],
      };
      const f = fixture(ambient);
      let matched: SceneSpeech | undefined;
      for (let seed = 1; seed <= 20; seed++) {
        const candidate = new SceneSpeech(seed, [ambient, vendor]);
        expect(
          candidate.admit(
            { ...f.scene, ambient: true, speakers: f.scene.speakers.slice(0, 1) },
            12,
          ),
        ).toBe(true);
        if (!!candidate.speech(f.a) === voiced) {
          matched = candidate;
          break;
        }
      }
      expect(matched).toBeDefined();
      const host = matched!;
      expect(host.selector.memory.ready([f.a], 20)).toBe(true);
      expect(host.selector.memory.ambientReady([f.a], 20)).toBe(false);
      host.step(at, true);
      expect(host.admit({ ...f.scene, key: {}, profiles: ['vendor-order'] }, 12)).toBe(true);
      expect(host.speech(f.a)).toMatchObject({ exchangeId: 'order', line: 0 });
      host.step(1.5, true);
      expect(host.speech(f.b)).toMatchObject({ exchangeId: 'order', line: 1 });
    },
  );
  it('validates each scene once per step and never while drawing people', () => {
    const f = fixture();
    let calls = 0;
    f.scene.valid = () => {
      calls++;
      return f.state.valid;
    };
    f.scenes.admit(f.scene, 12);
    f.scenes.step(0.1, true);
    const checked = calls;
    for (let i = 0; i < 500; i++) {
      f.scenes.speech(f.a);
      f.scenes.pose(f.a, 0);
      f.scenes.busy(f.a);
      f.scenes.pose({}, 0);
    }
    expect(calls).toBe(checked);
    f.state.valid = false;
    f.scenes.step(0, true);
    expect(calls).toBe(checked + 1);
    expect(f.scenes.speech(f.a)).toBeUndefined();
  });
  it('yields background owners and capacity to physical encounters', () => {
    const ambient: DialogueChoice = {
      id: 'happy',
      kind: 'talk',
      profile: 'daily-plans',
      delivery: 'utterance',
      turns: 1,
      speakers: [0],
    };
    const f = fixture(ambient);
    f.scenes.admit({ ...f.scene, ambient: true }, 12);
    expect(f.scenes.foregroundSize).toBe(0);
    f.scenes.reconcile(12, (owner) => owner === f.a);
    expect(f.scenes.size).toBe(0);
    const g = fixture(ambient);
    f.scenes.admit({ ...g.scene, ambient: true }, 12);
    f.scenes.reconcile(0, () => false);
    expect(f.scenes.size).toBe(0);
  });
  it('limits background expressions to two and makes space for service activity', () => {
    const utterance: DialogueChoice = {
      ...vendor,
      delivery: 'utterance',
      profile: 'daily-plans',
      turns: 1,
      speakers: [0],
    };
    const host = new SceneSpeech(1, [utterance, vendor]);
    for (let i = 0; i < 2; i++) {
      const f = fixture(utterance);
      expect(
        host.admit({ ...f.scene, ambient: true, speakers: f.scene.speakers.slice(0, 1) }, 12),
      ).toBe(true);
      expect(host.busy(f.a)).toBe(false);
    }
    const extra = fixture(utterance);
    expect(host.admit({ ...extra.scene, ambient: true }, 12)).toBe(false);
    expect(host.admit(fixture().scene, 12)).toBe(true);
    expect(host.admit(fixture().scene, 12)).toBe(true);
    expect(host.admit(fixture().scene, 12)).toBe(true);
    expect(host.size).toBe(4);
  });
  it('leaves capacity for physical encounters when many groups can speak', () => {
    const host = fixture().scenes;
    for (let i = 0; i < SCENE_SPEECH_CAPACITY; i++)
      expect(host.admit(fixture().scene, 12)).toBe(true);
    expect(host.admit(fixture().scene, 12)).toBe(false);
    expect(host.size).toBe(4);
  });
  it('does not evict an unrelated expression for a service too short to speak', () => {
    const utterance: DialogueChoice = {
      ...vendor,
      delivery: 'utterance',
      profile: 'daily-plans',
      turns: 1,
      speakers: [0],
    };
    const host = new SceneSpeech(1, [utterance, vendor]);
    const ambient = fixture(utterance);
    expect(host.admit({ ...ambient.scene, ambient: true }, 1)).toBe(true);
    expect(host.admit({ ...fixture().scene, remaining: 2.9 }, 1)).toBe(false);
    expect(host.size).toBe(1);
    expect(host.busy(ambient.a)).toBe(false);
    expect(host.admit(fixture().scene, 1)).toBe(true);
    expect(host.size).toBe(1);
  });
  it('places thanks in the final three seconds without changing the service lifetime', () => {
    const f = fixture({ ...vendor, profile: 'vendor-thanks' });
    f.scene.remaining = 8;
    expect(f.scenes.admit(f.scene, 12)).toBe(true);
    expect(f.scenes.speech(f.a)).toBeUndefined();
    f.scenes.step(5, true);
    expect(f.scenes.speech(f.a)).toMatchObject({ line: 0 });
    f.scenes.step(1.5, true);
    expect(f.scenes.speech(f.b)).toMatchObject({ line: 1 });
    f.scenes.step(1.5, true);
    expect(f.scenes.size).toBe(0);
    expect(f.scene.remaining).toBe(8);
  });
  it('fits two actual vendor/customer turns inside a three-second purchase', () => {
    const f = fixture();
    expect(f.scenes.admit(f.scene, 12)).toBe(true);
    expect(f.scenes.speech(f.a)).toMatchObject({ line: 0, member: 0 });
    expect(f.scenes.speech(f.b)).toBeUndefined();
    f.scenes.step(1.5, true);
    expect(f.scenes.speech(f.b)).toMatchObject({ line: 1 });
    f.scenes.step(1.5, true);
    expect(f.scenes.size).toBe(0);
    expect(f.scenes.admit(f.scene, 12)).toBe(false);
  });
  it('cancels remaining speech immediately on boarding, closure, departure or Life suppression', () => {
    const f = fixture();
    f.scenes.admit(f.scene, 12);
    f.state.valid = false;
    f.scenes.step(0, true);
    expect(f.scenes.speech(f.a)).toBeUndefined();
    f.scenes.step(0.1, true);
    expect(f.scenes.size).toBe(0);
    f.scenes.clear();
    f.state.valid = true;
    f.scenes.admit(f.scene, 12);
    f.scenes.step(0.1, false);
    expect(f.scenes.size).toBe(0);
  });
  it('does not stretch short services or exceed shared capacity', () => {
    const f = fixture();
    expect(f.scenes.admit({ ...f.scene, remaining: 2.9 }, 12)).toBe(false);
    expect(f.scenes.admit({ ...f.scene, key: {} }, 0)).toBe(false);
  });
  it('uses explicit reversed vendor turns and individual companion member slots', () => {
    const f = fixture({ ...vendor, speakers: [1, 0] });
    f.scenes.admit(f.scene, 12);
    expect(f.scenes.speech(f.b)).toMatchObject({ line: 0 });
    const g = fixture({
      id: 'companions',
      kind: 'talk',
      turns: 2,
      profile: 'companion',
      speakers: [0, 1],
    });
    g.scene.speakers = [g.scene.speakers[0]!, { owner: g.a, member: 1, figure: 'child' }];
    g.scene.remaining = undefined;
    g.scenes.admit(g.scene, 12);
    g.scenes.step(3, true);
    expect(g.scenes.speech(g.a)).toMatchObject({ line: 1, member: 1 });
    expect(g.scenes.pose(g.a, 0)).toBeUndefined();
    expect(g.scenes.pose(g.a, 1)).toBe('gesture');
  });
});

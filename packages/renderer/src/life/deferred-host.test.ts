import { expect, it, vi } from 'vitest';
import type { ProcessionRoute } from '@atlas/shared';
import type { LifeHost } from './host';
import { deferredHost } from './deferred-host';

function fixture() {
  const host = {
    sync: vi.fn(),
    clearTiles: vi.fn(),
    request: vi.fn(() => true),
    latest: vi.fn(),
    setEmergency: vi.fn(),
    setProcessions: vi.fn(),
    setLive: vi.fn(),
    play: vi.fn(() => true),
    stop: vi.fn(),
    dispose: vi.fn(),
    invalidateFrame: vi.fn(),
    invalidateFolklore: vi.fn(),
  } satisfies LifeHost;
  const create = vi.fn(() => host);
  let active = true;
  const route = { id: 'fixture' } as ProcessionRoute;
  const deferred = deferredHost(create, () => active, { processions: [route] });
  return {
    host,
    create,
    deferred,
    disable: () => {
      active = false;
    },
  };
}
it('coalesces state without spawning and replays the first tiles before the first frame', () => {
  const { host, create, deferred } = fixture();
  deferred.sync([], [1, 2]);
  deferred.sync([], [3, 4]);
  deferred.setEmergency();
  deferred.invalidateFrame();
  deferred.invalidateFolklore();
  expect(deferred.latest()).toBeUndefined();
  expect(deferred.request({} as Parameters<LifeHost['request']>[0])).toBe(false);
  expect(create).not.toHaveBeenCalled();
  deferred.start();
  deferred.start();
  expect(create).toHaveBeenCalledOnce();
  expect(host.sync).toHaveBeenCalledExactlyOnceWith([], [3, 4]);
  expect(host.setLive).toHaveBeenCalledWith(undefined);
  expect(host.setEmergency).toHaveBeenCalledWith(undefined);
  expect(deferred.request({} as Parameters<LifeHost['request']>[0])).toBe(true);
});
it('clear and stop remove superseded pending state and ordinary calls do not spawn', () => {
  const { host, create, deferred } = fixture();
  deferred.sync([], [1, 2]);
  deferred.clearTiles();
  deferred.setLive(undefined);
  deferred.stop();
  deferred.setProcessions([{ id: 'next' } as ProcessionRoute]);
  expect(create).not.toHaveBeenCalled();
  expect(deferred.play('invalid')).toBe(false);
  expect(create).not.toHaveBeenCalled();
  deferred.start();
  expect(host.sync).not.toHaveBeenCalled();
  expect(host.setLive).toHaveBeenCalledWith(undefined);
});
it('valid live/playback events can start early and playback acceptance stays synchronous', () => {
  const first = fixture();
  expect(first.deferred.play('fixture')).toBe(true);
  expect(first.create).toHaveBeenCalledOnce();
  const second = fixture();
  second.deferred.setLive('fixture', 0.5, '2026');
  expect(second.create).toHaveBeenCalledOnce();
  expect(second.host.setLive).toHaveBeenLastCalledWith('fixture', 0.5, '2026');
});
it('never constructs while inactive or after disposal', () => {
  const first = fixture();
  first.disable();
  first.deferred.start();
  first.deferred.setLive('fixture');
  expect(first.deferred.play('fixture')).toBe(false);
  expect(first.create).not.toHaveBeenCalled();
  const second = fixture();
  second.deferred.dispose();
  second.deferred.start();
  expect(second.create).not.toHaveBeenCalled();
  const third = fixture();
  third.deferred.start();
  third.deferred.dispose();
  third.deferred.dispose();
  expect(third.host.dispose).toHaveBeenCalledOnce();
});

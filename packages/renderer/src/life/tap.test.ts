import { describe, expect, it, vi } from 'vitest';
import { resolveTap, TapQueue, TapSources, type LifeTap, type TapHandlers } from './tap';
import type { VisibleAgent } from './simulate';
import { makeScenario, completeScenarioState } from './testing/scenarios';
it('leaves tap-free physical state and visible records identical with frame targeting enabled', () => {
  const a = makeScenario('sparse', 1, true),
    b = makeScenario('sparse', 1, true);
  b.world.enableTaps();
  for (let i = 0; i < 20; i++) {
    a.step(1 / 30);
    b.step(1 / 30);
    expect(b.world.visible(19, 1, b.center)).toEqual(a.world.visible(19, 1, a.center));
  }
  expect(completeScenarioState(b.world)).toEqual(completeScenarioState(a.world));
  expect(b.world.tapReceipts).toBeUndefined();
});

const agent: VisibleAgent = { kind: 'cat', lng: 0, lat: 0, ahead: [1, 0] };
function fixture() {
  const sources = new TapSources();
  sources.begin();
  sources.present({}, agent);
  sources.finish([agent]);
  const tap: LifeTap = {
    id: 1,
    generation: 1,
    frame: sources.frame,
    at: [0, 0],
    pointer: 'touch',
    cellMeters: 1,
  };
  const handlers: TapHandlers = {
    folklore: vi.fn(() => false),
    agent: vi.fn(),
    signal: vi.fn(() => false),
    procession: vi.fn(() => false),
    carnival: vi.fn(),
    candle: vi.fn(),
    tree: vi.fn(() => false),
    rice: vi.fn(() => true),
  };
  return { sources, tap, handlers };
}
describe('tap arbitration', () => {
  it('consumes a matched inactive cat instead of reaching a firework or feed', () => {
    const f = fixture();
    expect(resolveTap({ ...f.tap, agent: 0, firework: true }, f.sources, f.handlers).action).toBe(
      'agent',
    );
    expect(f.handlers.rice).not.toHaveBeenCalled();
    expect(f.handlers.signal).not.toHaveBeenCalled();
  });
  it.each(['folklore', 'signal', 'procession', 'tree'] as const)(
    'stops at the first accepted %s',
    (kind) => {
      const f = fixture();
      f.handlers[kind] = vi.fn(() => true);
      const receipt = resolveTap(
        { ...f.tap, folklore: 'ghost', firework: true },
        f.sources,
        f.handlers,
      );
      expect(receipt.action).toBe(kind);
      expect(f.handlers.rice).not.toHaveBeenCalled();
    },
  );
  it('puts fixture choices ahead of trees and fireworks, and never uses a second worker tap', () => {
    const f = fixture();
    const receipt = resolveTap(
      {
        ...f.tap,
        carnival: { key: 'ride', at: [0, 0] },
        candle: { key: 'candle', at: [0, 0] },
        firework: true,
      },
      f.sources,
      f.handlers,
    );
    expect(receipt.action).toBe('carnival');
    expect(f.handlers.carnival).toHaveBeenCalledOnce();
    expect(f.handlers.candle).not.toHaveBeenCalled();
    expect(f.handlers.tree).not.toHaveBeenCalled();
  });
  it('drops stale frame handles and invalid candidate indices without selecting an owner', () => {
    const f = fixture();
    f.sources.finish([]);
    expect(resolveTap({ ...f.tap, agent: 0 }, f.sources, f.handlers).action).toBe('agent');
    f.sources.finish([]);
    expect(resolveTap(f.tap, f.sources, f.handlers).action).toBeUndefined();
    expect(
      resolveTap({ ...f.tap, frame: f.sources.frame, agent: 5 }, f.sources, f.handlers).action,
    ).toBeUndefined();
    expect(agent.inspectionId).toBeUndefined();
  });
});
describe('tap queue', () => {
  it('retains rejected batches, bounds outstanding work, and consumes cached receipts once', () => {
    const f = fixture(),
      queue = new TapQueue();
    for (let i = 0; i < 5; i++) queue.add(f.tap);
    const batch = queue.batch(1)!;
    expect(batch).toHaveLength(4);
    expect(queue.batch(1)).toEqual(batch);
    queue.accepted(batch);
    expect(queue.batch(1)).toBeUndefined();
    const receipts = batch.map((tap) => ({ id: tap.id, action: 'rice' as const }));
    expect(queue.consume(receipts, 1)).toHaveLength(4);
    expect(queue.consume(receipts, 1)).toEqual([]);
  });
  it('drops pending commands and replies across resets and generation changes', () => {
    const f = fixture(),
      queue = new TapQueue();
    queue.add(f.tap);
    expect(queue.batch(2)).toBeUndefined();
    queue.add(f.tap);
    const batch = queue.batch(1)!;
    queue.accepted(batch);
    queue.clear();
    expect(queue.consume([{ id: batch[0]!.id, action: 'rice' }], 1)).toEqual([]);
  });
});

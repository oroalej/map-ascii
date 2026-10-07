import { describe, expect, it } from 'vitest';
import { encodeEmergency } from '@atlas/shared';
import { EmergencyRouter } from './emergency-network';
import { emergencyFixture } from './testing/emergency';

describe('directed emergency routing', () => {
  it('uses weighted interior terminals and retains the winning hospital', () => {
    const { data, point } = emergencyFixture(),
      router = new EmergencyRouter(data);
    const east = [1, 0] as const,
      south = [0, 1] as const;
    const route = router.scoreExits(point(100), [south, east], (h) => h, 'hospital');
    expect(route?.option).toBe(east);
    expect(route?.target.id).toBe('hospital/a');
    expect(route?.cost).toBeCloseTo(20);
    expect(router.routeAt(point(100, 70), 'hospital', south)?.target.id).toBe('hospital/b');
    expect(router.routeAt(point(100, 70), 'hospital', south)?.cost).toBeCloseTo(10, 0);
  });
  it('routes forward on a one-way partial edge, including a destination behind the cursor', () => {
    const { data, point } = emergencyFixture(),
      router = new EmergencyRouter(data);
    expect(router.routeAt(point(110), 'hospital/a', [1, 0])?.cost).toBeCloseTo(10, 0);
    expect(router.routeAt(point(130), 'hospital/a', [1, 0])?.cost).toBeCloseTo(390, 0);
    expect(router.positions(point(130), [-1, 0])).not.toContainEqual(
      expect.objectContaining({ edge: 1 }),
    );
    expect(router.path(point(130), 'hospital/a').map((l) => l.edge)).toEqual([3, 0, 1]);
  });
  it('matches nodes within three metres and leaves unmatched or unreachable exits to legacy routing', () => {
    const { network, point } = emergencyFixture(),
      router = new EmergencyRouter(encodeEmergency(network));
    expect(router.nodeAt(point(100, 2.9))).toBe(1);
    expect(router.nodeAt(point(100, 3.1))).toBeUndefined();
    expect(
      router.scoreExits(point(100), [[-0.7, -0.7]], (h) => h as [number, number], 'hospital'),
    ).toBeUndefined();
    expect(
      router.scoreExits(point(100), [[1, 0]], (h) => h as [number, number], 'missing'),
    ).toBeUndefined();
  });
  it('resolves partial segments on a long curved contracted chain in both directions', () => {
    const { network, point } = emergencyFixture();
    network.nodes = [point(0), point(200, 100)];
    network.edges = [
      {
        from: 0,
        to: 1,
        length: 300,
        bearing: [0, 0],
        oneway: 0,
        shape: [point(0), point(100), point(100, 100), point(200, 100)],
      },
    ];
    network.targets = [{ ...network.targets[0]!, edge: 0, t: 0.5, at: point(100, 50) }];
    const router = new EmergencyRouter(encodeEmergency(network));
    expect(router.routeAt(point(100, 40), 'hospital', [0, 1])?.cost).toBeCloseTo(10, 0);
    expect(router.routeAt(point(100, 60), 'hospital', [0, -1])?.cost).toBeCloseTo(10, 0);
    expect(router.path(point(100, 40), 'hospital')[0]?.fromT).toBeCloseTo(140 / 300, 2);
  });
});

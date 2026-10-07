import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { CityEmergency, decodeEmergency, encodeEmergency } from '@atlas/shared';

const generated = import.meta.glob('../../../apps/web/public/tiles/naga.emergency.json', {
  eager: true,
  import: 'default',
});

it('ships a validated compact network with reachable destinations and excluded guard houses', () => {
  const data = Object.values(generated)[0];
  expect(data).toBeDefined();
  const network = decodeEmergency(CityEmergency.parse(data));
  expect(network.nodes.length).toBeGreaterThan(100);
  expect(network.edges.length).toBeGreaterThan(100);
  for (const kind of ['hospital', 'police', 'fire', 'building'])
    expect(network.targets.some((target) => target.kind === kind)).toBe(true);
  expect(network.targets.map((target) => target.id)).not.toContain('osm:way/222404483');
  expect(network.targets.map((target) => target.id)).not.toContain('osm:way/222405532');
  expect(gzipSync(JSON.stringify(data) + '\n').length).toBeLessThanOrEqual(32 * 1024);
  const roundTrip = decodeEmergency(encodeEmergency(network));
  expect(roundTrip.nodes).toEqual(network.nodes);
  expect(roundTrip.targets.map((target) => target.id)).toEqual(
    network.targets.map((target) => target.id),
  );
});

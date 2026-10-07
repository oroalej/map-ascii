// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import naga from '../../../packages/content/cities/naga/city.json';

const fixture = vi.hoisted(() => ({ city: '', cemetery: false, mapped: false, landmark: '' }));
vi.mock('@playwright/test', () => ({ expect: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: (p: string | URL) => {
    const name = String(p);
    return (
      name.endsWith('/city.json') ||
      name.endsWith('.meta.json') ||
      (name.endsWith('/cemeteries/') && fixture.cemetery)
    );
  },
  readdirSync: (p: string | URL) =>
    String(p).endsWith('/cemeteries/') ? ['cemetery.json'] : ['fixture'],
  readFileSync: (p: string | URL) => {
    const name = String(p);
    if (name.endsWith('/city.json')) return fixture.city;
    if (name.endsWith('/cemetery.json')) return JSON.stringify({ osm_id: 'cemetery' });
    if (name.endsWith('.search-index.json'))
      return JSON.stringify({
        entries: [
          { id: 'smoke', type: 'landmark', name: fixture.landmark, altNames: [] },
          ...(fixture.mapped
            ? [{ id: 'cemetery', type: 'landmark', name: 'Cemetery', altNames: [] }]
            : []),
        ],
      });
    throw new Error(`Unexpected fixture read: ${name}`);
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  fixture.cemetery = false;
  fixture.mapped = false;
  fixture.landmark = naga.smoke_landmark;
});

function configure(sites: string[]) {
  const city = structuredClone(naga);
  city.life.folklore.ghosts.sites = sites;
  fixture.city = JSON.stringify(city);
}

it.each(['worship', 'hospital'])(
  'loads a %s-only folklore pack without a cemetery and parses Life once',
  async (site) => {
    configure([site]);
    const { RuntimeCityLifeSchema } = await import('@atlas/shared');
    const parse = vi.spyOn(RuntimeCityLifeSchema, 'parse');
    const { cities } = await import('../e2e/helpers');
    expect(cities).toHaveLength(1);
    expect(cities[0]).toMatchObject({ slug: 'fixture', folklore: true, cemeteryAnchor: undefined });
    expect(parse).toHaveBeenCalledOnce();
    expect(cities[0]!.seasons.length).toBeGreaterThan(0);
  },
);

it.each([false, true])(
  'requires a mapped cemetery for cemetery ghosts (file present: %s)',
  async (filePresent) => {
    configure(['cemetery']);
    fixture.cemetery = filePresent;
    await expect(import('../e2e/helpers')).rejects.toThrow(
      'folklore needs a mapped cemetery smoke anchor',
    );
  },
);

it('loads the mapped cemetery anchor when cemetery ghosts are enabled', async () => {
  configure(['cemetery']);
  fixture.cemetery = fixture.mapped = true;
  const { cities } = await import('../e2e/helpers');
  expect(cities[0]!.cemeteryAnchor?.id).toBe('cemetery');
});

import { describe, expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';

const records = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;
const landmarks = Object.values(records);
const heritage = landmarks.filter((landmark) => landmark.type === 'heritage');
const ordinance = 'https://www2.naga.gov.ph/prev-ordinance/ordinance-no-2003-003/';

// Unfinished research is tracked explicitly; accounting for scope does not satisfy full coverage.
const sites = [
  'almeda-ancestral-house',
  'roco-ancestral-house',
  'old-abella-mansion-arch',
  'old-provincial-jail',
  'administracion-de-correo',
  'lorenzo-house',
  'badiola-house',
  'amanse-house',
  'barlin-dimasalang-corner-house',
  'abella-paz-stone-structure',
  'elias-angeles-dimasalang-corner-house',
  'abella-business-buildings',
  'de-la-rosa-buildings',
  'villafrancia-house',
  'house-beside-villafrancia',
  'ocampo-house',
  'jordana-house',
  'yllana-house',
  'villa-ignacio-house',
  'dy-liacco-ancestral-house',
  'pantranco-stone-fence',
  'contreras-property-ruins',
  'contreras-adjacent-property-ruins',
] as const;

const pending: Partial<Record<(typeof sites)[number], string>> = {
  'old-provincial-jail':
    'Complex map, 1935 aerial, 2025 proposed plan and current frontage do not resolve the surviving jail/Cuartel to a separate georeferenced OSM outline; one proposed candidate is modern SJ Complex.',
  'administracion-de-correo':
    'The 1826 inscription account and Cuartel/Almacenes proposed-plan names need reconciliation with a current facade and distinct surviving OSM outline; the complex alone is insufficient.',
  'lorenzo-house':
    'Ordinance, registry searches and Barlin imagery provide no named facade or exact surviving family lot.',
  'badiola-house':
    'Alumni place Harong pub in Badiolas Barlin home, but its connection to the documented Sa Harong/Our House/Hillary/Jikka property remains unverified.',
  'amanse-house':
    'The official newsletter mentions Patricio Amanse without locating his family house; no named facade or exact surviving lot is resolved.',
  'barlin-dimasalang-corner-house':
    'Current imagery shows old houses on opposite corners, including Jikka to the east; the unnamed listed corner cannot be chosen by appearance or elimination.',
  'abella-paz-stone-structure':
    'Elias Angeles and Paz identifies an intersection, but no source/photo establishes which corner footprint is the surviving Abella structure.',
  'elias-angeles-dimasalang-corner-house':
    'Several corner footprints remain plausible; no surviving-house identity or marker verified.',
  'de-la-rosa-buildings':
    'Calle Caceres is named, but no surviving De la Rosa building or row footprint is independently identified.',
  'villafrancia-house':
    'Named 2009/2011 facade references and sparse current/historical panoramas leave the exact surviving lot unresolved; the Flickr coarse public pin is not reliable footprint evidence.',
  'house-beside-villafrancia':
    'The Villafrancia parent lot is unresolved, so its unspecified neighboring house cannot be identified.',
  'ocampo-house': 'Peñafrancia Avenue only; no family marker or exact surviving lot verified.',
  'jordana-house':
    'The official Jordana Street naming, 1969 cadastral neighbor notice and Camarines Lumber compound lead do not identify the surviving ancestral house outline.',
  'yllana-house':
    'The primary 2016 stockholder address 252 Liboton is a locator without a named facade or proof of the surviving historic footprint.',
  'villa-ignacio-house':
    'A WWII recollection locates an Ignacio house in Liboton; its separately mentioned Jacob-corner house is not a valid substitute. The exact surviving lot remains unverified.',
  'dy-liacco-ancestral-house':
    'Primary family recollections describe the Igualdad home opposite the old jail/capitol, but do not resolve a current matched facade or exact OSM lot; Tabuco family addresses are distinct.',
  'pantranco-stone-fence':
    'The ordinance identifies a fence, with no verified surviving building host; standalone wall geometry is excluded.',
  'contreras-property-ruins':
    'Balintawak Street and a historical office address do not identify the surviving Contreras ruins on an existing building footprint.',
  'contreras-adjacent-property-ruins':
    'The adjacent property is unnamed; its location, survival and separate building footprint remain unresolved.',
};

describe('Naga heritage scope', () => {
  it('accounts for each requested site and conditional ruin as implemented or unfinished', () => {
    const added = heritage.map((landmark) => landmark.id.replace('landmark/', ''));
    expect([...added, ...Object.keys(pending)].sort()).toEqual([...sites].sort());
    for (const site of sites) {
      expect(Number(added.includes(site)) + Number(site in pending)).toBe(1);
      if (site in pending) expect(pending[site]!.length).toBeGreaterThan(30);
    }
  });

  it('sources each heritage identity and attaches it to a unique OSM footprint', () => {
    for (const landmark of heritage) {
      expect(landmark.osm_id).toMatch(/^osm:way\/\d+$/);
      expect(landmark.geometry).toBeUndefined();
      expect(landmark.sources[0]!.url).toBe(
        `https://www.openstreetmap.org/way/${landmark.osm_id!.split('/')[1]}`,
      );
      expect(
        landmark.sources.some(
          (source) => source.url === ordinance || /owner.*request/i.test(source.title),
        ),
      ).toBe(true);
    }
    const attached = landmarks.flatMap((landmark) => (landmark.osm_id ? [landmark.osm_id] : []));
    expect(new Set(attached).size).toBe(attached.length);
  });

  it('keeps the arch host undated and distinguishes it from the former mansion', () => {
    const arch = heritage.find((landmark) => landmark.id === 'landmark/old-abella-mansion-arch')!;
    expect(arch.osm_id).toBe('osm:way/23665222');
    expect(arch.start_year).toBeUndefined();
    expect(arch.sources[0]!.note).toContain('it is not the historic mansion');
    expect(arch.facts).toHaveLength(4);
  });

  it('keeps the surviving Roco house on its independently identified Barlin footprint', () => {
    const roco = heritage.find((landmark) => landmark.id === 'landmark/roco-ancestral-house')!;
    expect(roco.osm_id).toBe('osm:way/23668511');
    expect(roco.start_year).toBeUndefined();
    expect(roco.facts).toHaveLength(3);
    expect(roco.sources.some((source) => source.url?.includes('Dec_2025.jpg'))).toBe(true);
  });

  it('keeps Almeda undated while construction sources conflict', () => {
    const almeda = heritage.find((landmark) => landmark.id === 'landmark/almeda-ancestral-house')!;
    expect(almeda.osm_id).toBe('osm:way/23664606');
    expect(almeda.start_year).toBeUndefined();
    expect(almeda.facts).toHaveLength(5);
    expect(almeda.sources.some((source) => source.url?.includes('NLP00VM052mcd'))).toBe(true);
    expect(almeda.sources.some((source) => source.note?.includes('1938'))).toBe(true);
    expect(almeda.sources.some((source) => source.note?.includes('1941'))).toBe(true);
  });

  it('attaches one independently identified representative of the Abella business row', () => {
    const row = heritage.find((landmark) => landmark.id === 'landmark/abella-business-buildings')!;
    expect(row.osm_id).toBe('osm:way/23674415');
    expect(row.start_year).toBeUndefined();
    expect(row.sources.some((source) => source.url?.includes('jollibee-naga-gen-luna'))).toBe(true);
    expect(row.sources[0]!.note).toContain('representative');
  });
});

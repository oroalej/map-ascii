import { describe, expect, it } from 'vitest';
import { Landmark } from '@atlas/shared';

const records = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
});
const landmarks = Object.values(records).map((record) => Landmark.parse(record));
const heritage = landmarks.filter((landmark) => landmark.type === 'heritage');
const ordinance = 'https://www2.naga.gov.ph/prev-ordinance/ordinance-no-2003-003/';

// Each scope identity has its own disposition; unresolved corners never borrow a nearby roof.
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

const omitted: Partial<Record<(typeof sites)[number], string>> = {
  'almeda-ancestral-house':
    'Abella Street is supported, but the proposed coordinate is from an AI-assisted directory. Canopy obscures the candidate roof; no independently identified surviving footprint.',
  'roco-ancestral-house':
    'The ordinance and 2009 blog identify Barlin Street and a wooden house, but the photograph cannot be tied to one current OSM lot.',
  'old-provincial-jail':
    'The sources identify the two-building complex behind PhilamLife; neither the published map nor inspected imagery resolves a separate surviving jail footprint.',
  'administracion-de-correo':
    'The source identifies the right-hand 1826 building, but the facade inscription cannot be matched to a distinct surviving OSM footprint; the complex alone is insufficient.',
  'lorenzo-house': 'Barlin Street only; no family marker or lot-specific imagery match found.',
  'badiola-house': 'Barlin Street only; no family marker or lot-specific imagery match found.',
  'amanse-house': 'Barlin Street only; no family marker or lot-specific imagery match found.',
  'barlin-dimasalang-corner-house':
    'The named intersection has several building footprints; no evidence resolves the surviving listed house to one corner.',
  'abella-paz-stone-structure':
    'Elias Angeles and Paz identifies an intersection, but no source/photo establishes which corner footprint is the surviving Abella structure.',
  'elias-angeles-dimasalang-corner-house':
    'Several corner footprints remain plausible; no surviving-house identity or marker verified.',
  'abella-business-buildings':
    'No identifiable surviving row or representative building on General Luna verified; modern commercial roofs are insufficient.',
  'de-la-rosa-buildings':
    'Calle Caceres is named, but no surviving De la Rosa building or row footprint is independently identified.',
  'villafrancia-house':
    'The 2009 photograph shows VILLAFRANCIA 1927, but no exact Peñafrancia Avenue lot or surviving OSM footprint is resolved.',
  'house-beside-villafrancia':
    'The Villafrancia parent lot is unresolved, so its unspecified neighboring house cannot be identified.',
  'ocampo-house': 'Peñafrancia Avenue only; no family marker or exact surviving lot verified.',
  'jordana-house': 'Peñafrancia Avenue only; no family marker or exact surviving lot verified.',
  'yllana-house': 'Liboton Street only; no exact surviving Yllana footprint verified.',
  'villa-ignacio-house':
    'Liboton Street only; no exact surviving Villa Ignacio footprint verified.',
  'dy-liacco-ancestral-house':
    'J. Hernandez Avenue only; no exact surviving Dy-Liacco footprint verified.',
  'pantranco-stone-fence':
    'The ordinance identifies a fence, with no verified surviving building host; standalone wall geometry is excluded.',
  'contreras-property-ruins':
    'Balintawak Street and a historical office address do not identify the surviving Contreras ruins on an existing building footprint.',
  'contreras-adjacent-property-ruins':
    'The adjacent property is unnamed; its location, survival and separate building footprint remain unresolved.',
};

describe('Naga heritage scope', () => {
  it('accounts for each requested site and conditional ruin with exactly one disposition', () => {
    const added = heritage.map((landmark) => landmark.id.replace('landmark/', ''));
    expect([...added, ...Object.keys(omitted)].sort()).toEqual([...sites].sort());
    for (const site of sites) {
      expect(Number(added.includes(site)) + Number(site in omitted)).toBe(1);
      if (site in omitted) expect(omitted[site]!.length).toBeGreaterThan(30);
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
});

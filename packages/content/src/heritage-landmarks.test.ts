import { describe, expect, it } from 'vitest';
import type { Landmark } from '@atlas/shared';

const records = import.meta.glob('../cities/naga/landmarks/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Landmark>;
const landmarks = Object.values(records);
const heritage = landmarks.filter((landmark) => landmark.type === 'heritage');
const ordinance = 'https://www2.naga.gov.ph/prev-ordinance/ordinance-no-2003-003/';

// Every requested site and conditional ruin is either a heritage landmark or omitted with a reason.
const sites = [
  'almeda-ancestral-house',
  'bichara-theatre',
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
  'lorenzo-house':
    'A Street View sweep of Barlin Street (August 2025) found no Lorenzo sign, gate or plaque, and no source ties the family to a Barlin lot.',
  'amanse-house':
    'Bicol Star issues of 1964-1970 document the Amanse family without a street, and the Barlin Street sweep found no Amanse sign or address.',
  'de-la-rosa-buildings':
    'A Calle Caceres Street View sweep (2025) found no De la Rosa sign or lettering, only a De Leon building, and no source locates the De la Rosa row.',
  'ocampo-house':
    'A dense Peñafrancia Avenue Street View sweep (August 2025) found no Ocampo sign or lettering, and no source ties the family to an avenue lot.',
  'jordana-house':
    'The Jordana compound beside San Francisco Church (New Camarines Lumber lane) holds several old structures and no Jordana sign, so no single house can be chosen.',
  'yllana-house':
    'Street View sweeps of both former Liboton streets (Carpio and M. T. Villanueva) found no Yllana sign and no house numbered 252, the 2016 stockholder address.',
  'villa-ignacio-house':
    'A wartime report places the Villa Ignacio house only somewhere in Liboton, and sweeps of both former Liboton streets found no Villa Ignacio lettering.',
  'dy-liacco-ancestral-house':
    'Igualdad is today J. Hernandez Avenue, but family recollections give no lot, and a sweep of the avenue found no Dy-Liacco lettering on any old house.',
  'pantranco-stone-fence':
    'A P. Diaz Street sweep (August 2025) found no stone fence or old terminal building, and a wall alone has no building footprint to attach to.',
  'contreras-property-ruins':
    'A roofless stone ruin stands on Balintawak Street near 13.61995, 123.18525, but nothing ties it to the Contreras name and its OSM way covers the yard, not the walls.',
  'contreras-adjacent-property-ruins':
    'The neighbouring lot shows only a cut-stone pier and wall, with no building of its own, and the Contreras lot itself is unidentified.',
};

describe('Naga heritage scope', () => {
  it('accounts for each requested site and conditional ruin as added or omitted', () => {
    const added = heritage.map((landmark) => landmark.id.replace('landmark/', ''));
    expect([...added, ...Object.keys(omitted)].sort()).toEqual([...sites].sort());
    for (const site of sites) {
      expect(Number(added.includes(site)) + Number(site in omitted)).toBe(1);
      if (site in omitted) expect(omitted[site]!.length).toBeGreaterThan(30);
    }
  });

  it('sources each heritage identity and attaches it to a unique OSM footprint or outline', () => {
    for (const landmark of heritage) {
      const way = landmark.osm_id ?? landmark.replaces;
      expect(way).toMatch(/^osm:way\/\d+$/);
      // Curated outlines replace an OSM building; every other site keeps its OSM footprint.
      expect(landmark.geometry?.type ?? 'osm').toBe(landmark.replaces ? 'Polygon' : 'osm');
      expect(landmark.sources[0]!.url).toBe(
        `https://www.openstreetmap.org/way/${way!.split('/')[1]}`,
      );
      expect(
        landmark.sources.some(
          (source) => source.url === ordinance || /owner.*request/i.test(source.title),
        ),
      ).toBe(true);
    }
    const attached = landmarks.flatMap((landmark) => (landmark.osm_id ? [landmark.osm_id] : []));
    expect(new Set(attached).size).toBe(attached.length);
    const replaced = landmarks.flatMap((landmark) =>
      landmark.replaces ? [landmark.replaces] : [],
    );
    expect(replaced.filter((id) => attached.includes(id))).toEqual([]);
  });

  it('splits the aggregate OSM ruin outline into the jail and the post office, undated', () => {
    const ruins = ['old-provincial-jail', 'administracion-de-correo'].map((slug) =>
      heritage.find((landmark) => landmark.id === `landmark/${slug}`)!,
    );
    for (const ruin of ruins) {
      expect(ruin.replaces).toBe('osm:way/23672266');
      expect(ruin.start_year).toBeUndefined();
      expect(ruin.sources.some((source) => source.title.includes('traced'))).toBe(true);
    }
  });

  it('keeps the arch host undated and distinguishes it from the former mansion', () => {
    const arch = heritage.find((landmark) => landmark.id === 'landmark/old-abella-mansion-arch')!;
    expect(arch.osm_id).toBe('osm:way/23671432');
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

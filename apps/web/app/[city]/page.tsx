import type { Metadata } from 'next';
import { runtimeDialogueCatalog, runtimeCityLife } from '@atlas/shared';
import { notFound } from 'next/navigation';
import { CityAtlas } from '@/components/CityAtlas';
import { loadCity, loadRegistry } from '@/lib/cities';

/** Only registered cities have pages (static export: one page per city pack). */
export const dynamicParams = false;

export async function generateStaticParams() {
  return (await loadRegistry()).map(({ city }) => ({ city: city.slug }));
}

type Props = { params: Promise<{ city: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const pack = await loadCity((await params).city);
  return { title: pack ? `${pack.city.name.en} · ASCII Atlas` : 'ASCII Atlas' };
}

export default async function CityPage({ params }: Props) {
  const pack = await loadCity((await params).city);
  if (!pack) notFound();
  const { city, content } = pack;
  return (
    <main>
      <CityAtlas
        slug={city.slug}
        name={city.name.en}
        subdivisionLabel={city.subdivision.label.en}
        traffic={city.traffic}
        climate={city.climate}
        timezone={city.timezone}
        cityLife={city.life ? runtimeCityLife(city.life) : undefined}
        dialogue={runtimeDialogueCatalog(pack.dialogue)}
        utilitiesDerived={city.streets?.utilities?.derive === true}
        sidewalksDerived={city.streets?.sidewalks?.derive !== false}
        landmarks={content.landmarks}
        art={content.art}
        tours={content.tours}
      />
    </main>
  );
}

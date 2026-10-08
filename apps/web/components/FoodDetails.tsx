'use client';
import type { Dish, Landmark } from '@atlas/shared';
import { selectPlace } from '@/state/selection';
import { Citation, FactList, SourceList } from './SourcedFacts';
import styles from './LandmarkDetails.module.css';

const origins = new Map<Dish['origin'], string>([
  ['bicol', 'Bicol'],
  ['contested', 'Contested'],
  ['elsewhere', 'Elsewhere'],
  ['unknown', 'Unknown'],
]);
export function DishDetails({ dish, prefix }: { dish: Dish; prefix: string }) {
  return (
    <>
      <p className={styles.meta}>Origin: {origins.get(dish.origin) ?? 'Local'}</p>
      <p>{dish.description.en}</p>
      <FactList facts={dish.facts} sources={dish.sources} prefix={prefix} />
      <SourceList sources={dish.sources} prefix={prefix} />
    </>
  );
}
export function FoodDetails({
  landmark,
  dishes,
  prefix,
}: {
  landmark: Landmark;
  dishes: readonly Dish[];
  prefix: string;
}) {
  const linked = dishes.filter((dish) => landmark.known_for?.includes(dish.id));
  const menu = (items: NonNullable<Landmark['signatures']>) => (
    <ul className={styles.facts}>
      {items.map((item, index) => (
        <li key={index}>
          {item.name}
          {item.note && <> — {item.note}</>}
          <Citation sources={landmark.sources} source={item.source} prefix={prefix} />
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {landmark.signatures?.length || linked.length ? (
        <section>
          <h3>Known for</h3>
          {landmark.signatures?.length ? menu(landmark.signatures) : null}
          {linked.map((dish) => (
            <section key={dish.id}>
              <h4>
                <button
                  className={styles.dishLink}
                  type="button"
                  onClick={() => selectPlace(dish.id, { origin: 'keyboard' })}
                >
                  {dish.name.en}
                </button>
              </h4>
              <DishDetails dish={dish} prefix={`${prefix}-${dish.id.replace('/', '-')}`} />
            </section>
          ))}
        </section>
      ) : null}
      {!!landmark.pasalubong?.length && (
        <section>
          <h3>Pasalubong</h3>
          {menu(landmark.pasalubong)}
        </section>
      )}
    </>
  );
}

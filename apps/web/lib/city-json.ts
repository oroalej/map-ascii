/** Cached generated data; rejected promises are forgotten so explicit demand can retry. */
export function cityJson<T>(suffix: string, guard: (value: unknown) => value is T, missing?: T) {
  const loaded = new Map<string, Promise<T>>();
  return (city: string): Promise<T> => {
    let promise = loaded.get(city);
    if (!promise) {
      promise = (async () => {
        const response = await fetch(`/tiles/${city}.${suffix}.json`);
        if (response.status === 404 && missing !== undefined) return missing;
        if (!response.ok) throw new Error(`${city}.${suffix}: HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (!guard(value)) throw new Error(`${city}.${suffix}: invalid data`);
        return value;
      })();
      loaded.set(city, promise);
      void promise.catch(() => {
        if (loaded.get(city) === promise) loaded.delete(city);
      });
    }
    return promise;
  };
}

/** Eager and cooperative preparation consume the same iterator and random stream order. */
export function complete<T>(work: Generator<void, T, void>): T {
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}

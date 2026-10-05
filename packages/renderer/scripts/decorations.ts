/** Remove only the documented decorative key on tile snapshots, never mover/scene fields. */
export function withoutDecorations<T>(state: T): T {
  const copy = structuredClone(state);
  const strip = (tile: unknown) => {
    if (tile && typeof tile === 'object') delete (tile as { decorations?: unknown }).decorations;
  };
  if (Array.isArray(copy)) copy.forEach(strip);
  else if (copy && typeof copy === 'object') {
    const world = copy as { tiles?: unknown[]; retired?: unknown[] };
    world.tiles?.forEach(strip);
    world.retired?.forEach(strip);
  }
  return copy;
}

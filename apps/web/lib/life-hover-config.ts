/** Empty build settings use the shipped default; nonempty mistakes fail loudly. */
export function parseLifeHoverPause(value: string | undefined): 'item' | 'all' {
  const mode = value || 'item';
  if (mode !== 'item' && mode !== 'all')
    throw new Error('NEXT_PUBLIC_LIFE_HOVER_PAUSE must be item or all');
  return mode;
}

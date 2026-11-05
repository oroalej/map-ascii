/**
 * Where the manananggal's frames sit in its sheet. It's apart from the painter
 * (`manananggal-sprite.ts`), which loads on its own the first time the figure shows.
 */
export const SPRITE_SIZE = 48;
export const SPRITE_COLUMNS = 6;

/** Where each set of frames starts in the sheet. */
export const SpriteFrame = {
  /** The wings through one beat. Index 0 is the glide. */
  flap: 0,
  flaps: 8,
  /** From the glide to wings folded along its back like a cloak. */
  fold: 8,
  folds: 4,
  /** Hunched on a roof, wings folded, tongue let out ahead and swaying. */
  perch: 12,
  perches: 4,
  /** The entrails trailing and swaying, drawn under the flap and fold frames. */
  trail: 16,
  trails: 4,
  /** The legs. */
  lower: 20,
  count: 21,
} as const;

export const SPRITE_ROWS = Math.ceil(SpriteFrame.count / SPRITE_COLUMNS);

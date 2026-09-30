/**
 * When the frame loop draws its animation (water, trees in the wind, agents, a selection's
 * shimmer): every frame just after input, else at an idle rate, and not at all while no one can
 * watch it (reduced motion, a hidden or unfocused tab, the map scrolled off screen). A frame
 * that has something new to show (tiles, the camera, the time of day) still draws; this only
 * decides whether the map moves on its own.
 */

/** While idle, animation redraws at most this often. */
export const IDLE_FRAME_MS = 1000 / 30;
/** How long after input the loop keeps drawing every frame. */
export const ACTIVE_MS = 500;

export type Pacing = {
  /** With reduced motion, the map never moves on its own. */
  reducedMotion: boolean;
  /** Whether anyone can watch the map (`watchVisibility`). */
  watched: boolean;
};

/** Whether the animation is due a frame at `now` (ms, like `lastDraw` and `lastInput`). */
export function animationDue(
  now: number,
  lastDraw: number,
  lastInput: number,
  { reducedMotion, watched }: Pacing,
): boolean {
  if (reducedMotion || !watched) return false;
  const interval = now - lastInput < ACTIVE_MS ? 0 : IDLE_FRAME_MS;
  return now - lastDraw >= interval;
}

/**
 * Whether anyone can watch `canvas`: its tab is shown and focused, and it is on screen. Calls
 * `onChange(watched)` when that changes.
 */
export function watchVisibility(canvas: HTMLCanvasElement, onChange: (watched: boolean) => void) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  let focused = doc.hasFocus();
  let onScreen = true;
  const watched = () => !doc.hidden && focused && onScreen;
  let last = watched();
  const update = () => {
    const now = watched();
    if (now === last) return;
    last = now;
    onChange(now);
  };
  const onFocus = () => {
    focused = true;
    update();
  };
  const onBlur = () => {
    focused = false;
    update();
  };
  doc.addEventListener('visibilitychange', update);
  win?.addEventListener('focus', onFocus);
  win?.addEventListener('blur', onBlur);
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          onScreen = entry.isIntersecting;
          update();
        });
  observer?.observe(canvas);
  return {
    watched: () => last,
    detach() {
      doc.removeEventListener('visibilitychange', update);
      win?.removeEventListener('focus', onFocus);
      win?.removeEventListener('blur', onBlur);
      observer?.disconnect();
    },
  };
}

/**
 * When the frame loop draws its animation (water, trees in the wind, agents, a selection's
 * shimmer): every frame just after input, else at an idle rate, and not at all while no one can
 * watch it (reduced motion, a hidden or unfocused tab, the map scrolled off screen). A frame
 * that has something new to show (tiles, the camera, the time of day) still draws; this only
 * decides whether the map moves on its own.
 */

/** While idle, animation redraws at most this often (30 fps). */
export const IDLE_FRAME_MS = 1000 / 30;
/** Interaction (input, camera moves, the animation just after them) draws at most this often. */
export const ACTIVE_FRAME_MS = 1000 / 60;
/**
 * How early a frame may come and still count as due: rAF timestamps jitter around the display's
 * period, so an exact interval would skip every other 60 Hz tick (33 ms, then 50 ms).
 */
export const PACING_SLACK_MS = 4;
/** How long after input the loop keeps drawing at the interactive rate. */
export const ACTIVE_MS = 500;

export type Pacing = {
  /** With reduced motion, the map never moves on its own. */
  reducedMotion: boolean;
  /** Whether anyone can watch the map (`watchVisibility`). */
  watched: boolean;
};

/** Whether a frame at `now` keeps to `interval` after the last one drawn. */
const due = (now: number, lastDraw: number, interval: number) =>
  now - lastDraw >= interval - PACING_SLACK_MS;

/**
 * Whether the animation is due a frame at `now` (ms, like `lastDraw` and `lastInput`): 60 fps
 * just after input (every frame at 60 Hz, every second one at 120 or 144 Hz), else 30 fps.
 */
export function animationDue(
  now: number,
  lastDraw: number,
  lastInput: number,
  { reducedMotion, watched }: Pacing,
): boolean {
  if (reducedMotion || !watched) return false;
  return due(now, lastDraw, now - lastInput < ACTIVE_MS ? ACTIVE_FRAME_MS : IDLE_FRAME_MS);
}

/**
 * Whether a moved camera may draw at `now`. It keeps to the interactive rate, so a fast display
 * doesn't redraw every tick; with reduced motion, or while no one watches, it draws at once.
 */
export function cameraDue(now: number, lastDraw: number, { reducedMotion, watched }: Pacing) {
  return reducedMotion || !watched || due(now, lastDraw, ACTIVE_FRAME_MS);
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

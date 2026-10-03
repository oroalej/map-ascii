import { uprightStreetAngle } from './label-layout';
import type { TileLabel } from './raster/geometry';

const runLength = (label: TileLabel) =>
  label.run
    ? Math.hypot(
        (label.run[1][0] - label.run[0][0]) *
          Math.cos(((label.run[0][1] + label.run[1][1]) * Math.PI) / 360),
        label.run[1][1] - label.run[0][1],
      )
    : -1;

function compareCoordinates(a: TileLabel, b: TileLabel): number {
  if (a === b) return 0;
  const anchor = a.lng - b.lng || a.lat - b.lat;
  if (anchor) return anchor;
  const ar = a.run,
    br = b.run;
  if (ar && br) {
    // Compare the same canonical endpoint order without sorting/flattening arrays for
    // every duplicate or retained copy. Endpoints are immutable during collection.
    const ai = ar[0][0] - ar[1][0] || ar[0][1] - ar[1][1];
    const bi = br[0][0] - br[1][0] || br[0][1] - br[1][1];
    const a0 = ar[ai > 0 ? 1 : 0],
      a1 = ar[ai > 0 ? 0 : 1];
    const b0 = br[bi > 0 ? 1 : 0],
      b1 = br[bi > 0 ? 0 : 1];
    return (
      a0[0] - b0[0] ||
      a0[1] - b0[1] ||
      a1[0] - b1[0] ||
      a1[1] - b1[1] ||
      uprightStreetAngle(a.angle ?? 0) - uprightStreetAngle(b.angle ?? 0)
    );
  }
  if (!ar && !br) return uprightStreetAngle(a.angle ?? 0) - uprightStreetAngle(b.angle ?? 0);
  // Mixed copies cannot tie on run length or represent the same retained copy.
  return ar ? 1 : -1;
}

const sameCopy = (a: TileLabel, b: TileLabel) =>
  a.text === b.text &&
  a.rank === b.rank &&
  a.band.min === b.band.min &&
  a.band.max === b.band.max &&
  compareCoordinates(a, b) === 0;

/** Eligible copies prefer visible text, deeper geometry, retention, then run length. */
export function collectLabel(
  labels: Map<number, TileLabel>,
  label: TileLabel,
  previous?: TileLabel,
  onScreen: (label: TileLabel) => boolean = () => true,
  sourceZoom: (label: TileLabel) => number = () => 0,
): void {
  const old = labels.get(label.id);
  if (!old) {
    labels.set(label.id, label);
    return;
  }
  const visible = onScreen(label),
    oldVisible = onScreen(old);
  if (visible !== oldVisible) {
    if (visible) labels.set(label.id, label);
    return;
  }
  const depth = sourceZoom(label) - sourceZoom(old);
  if (depth) {
    if (depth > 0) labels.set(label.id, label);
    return;
  }
  if (previous) {
    const kept = sameCopy(old, previous),
      incomingKept = sameCopy(label, previous);
    if (kept !== incomingKept) {
      if (incomingKept) labels.set(label.id, label);
      return;
    }
  }
  const difference = runLength(label) - runLength(old);
  if (difference > 0 || (difference === 0 && compareCoordinates(label, old) < 0))
    labels.set(label.id, label);
}

export function collectLabels(
  labels: Iterable<TileLabel>,
  previous: ReadonlyMap<number, TileLabel>,
  eligible: (label: TileLabel, kept: boolean) => boolean,
  onScreen?: (label: TileLabel) => boolean,
  sourceZoom?: (label: TileLabel) => number,
): Map<number, TileLabel> {
  const collected = new Map<number, TileLabel>();
  for (const label of labels) {
    if (eligible(label, previous.has(label.id)))
      collectLabel(collected, label, previous.get(label.id), onScreen, sourceZoom);
  }
  return collected;
}

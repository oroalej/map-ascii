import type { LabelArea, LabelCandidate, Overlay } from './labels';
import {
  labelSlots,
  orderLabels,
  retentionArea,
  type LabelSlot,
  type PlaceStability,
} from './label-stability';

export type Box = { left: number; top: number; width: number; height: number };
export const TAKEN_PAD = 4;
export const LABEL_WIDTH = 18;

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;
const inside = (box: Box, area: LabelArea) =>
  box.left >= area.left &&
  box.top >= area.top &&
  box.left + box.width <= area.right &&
  box.top + box.height <= area.bottom;
export const labelIntersectsArea = (box: Box, area: LabelArea) =>
  overlaps(box, {
    left: area.left,
    top: area.top,
    width: area.right - area.left,
    height: area.bottom - area.top,
  });

const inTakenCells = (o: Overlay, b: Box) =>
  b.left >= -TAKEN_PAD &&
  b.top >= -TAKEN_PAD &&
  b.left + b.width <= o.cols + TAKEN_PAD &&
  b.top + b.height <= o.rows + TAKEN_PAD;
function isTaken(o: Overlay, box: Box): boolean {
  if (!o.takenCells || !inTakenCells(o, box)) return o.taken.some((taken) => overlaps(taken, box));
  const stride = o.cols + 2 * TAKEN_PAD;
  for (let y = box.top; y < box.top + box.height; y++) {
    const row = (y + TAKEN_PAD) * stride + TAKEN_PAD;
    for (let x = box.left; x < box.left + box.width; x++) if (o.takenCells[row + x]) return true;
  }
  return false;
}
function take(o: Overlay, box: Box) {
  o.taken.push(box);
  if (!o.takenCells) return;
  const stride = o.cols + 2 * TAKEN_PAD;
  for (
    let y = Math.max(box.top, -TAKEN_PAD);
    y < Math.min(box.top + box.height, o.rows + TAKEN_PAD);
    y++
  ) {
    const row = (y + TAKEN_PAD) * stride + TAKEN_PAD;
    for (
      let x = Math.max(box.left, -TAKEN_PAD);
      x < Math.min(box.left + box.width, o.cols + TAKEN_PAD);
      x++
    ) {
      o.takenCells[row + x] = 1;
    }
  }
}

export function wrapText(text: string, width = LABEL_WIDTH): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

const wrapped = new Map<string, { lines: string[]; width: number }>();
const WRAPPED_MAX = 20_000;
function wrapOnce(text: string) {
  let found = wrapped.get(text);
  if (!found) {
    const lines = wrapText(text);
    found = { lines, width: Math.max(0, ...lines.map((line) => [...line].length)) };
    if (wrapped.size >= WRAPPED_MAX) wrapped.clear();
    wrapped.set(text, found);
  }
  return found;
}

export function uprightStreetAngle(angle: number): number {
  return ((((angle + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
}

function rotatedBounds(
  col: number,
  row: number,
  width: number,
  height: number,
  angle: number,
  aspect: number,
): Box {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const w = c * width + s * aspect * height,
    h = (s * width) / aspect + c * height;
  return { left: col + 0.5 - w / 2, top: row + 0.5 - h / 2, width: w, height: h };
}

export function rotatedLabelBox(
  col: number,
  row: number,
  width: number,
  angle: number,
  aspect = 1.8,
): Box {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const w = c * (width + 2) + s * aspect * 1.4;
  const h = (s * (width + 2)) / aspect + c * 1.4;
  const left = Math.floor(col + 0.5 - w / 2),
    top = Math.floor(row + 0.5 - h / 2);
  return {
    left,
    top,
    width: Math.ceil(col + 0.5 + w / 2) - left,
    height: Math.ceil(row + 0.5 + h / 2) - top,
  };
}

type BesideLayout = {
  slot: 0 | 1 | 2 | 3;
  box: Box;
  collision: Box;
  textBounds: Box;
  lines: string[];
  width: number;
};
type RotatedLayout = {
  slot: -1;
  box: Box;
  collision: Box;
  textBounds: Box;
  chars: string[];
  angle: number;
};
export type LabelLayout = (BesideLayout | RotatedLayout) & { label: LabelCandidate };

function slotLayout(
  label: LabelCandidate,
  slot: LabelSlot,
  aspect: number,
): LabelLayout | undefined {
  const { col, row } = label;
  if (slot === -1) {
    if (label.mode !== 'rotated') return;
    const chars = [...label.text.trim()],
      angle = uprightStreetAngle(label.angle ?? 0);
    if (!chars.length || (label.runCells !== undefined && chars.length + 2 > label.runCells))
      return;
    const box = rotatedLabelBox(col, row, chars.length, angle, aspect);
    return {
      label,
      slot,
      box,
      collision: box,
      chars,
      angle,
      textBounds: rotatedBounds(col, row, chars.length, 1, angle, aspect),
    };
  }
  const { lines, width } = wrapOnce(label.text);
  if (!lines.length || !lines[0]) return;
  const height = lines.length,
    centered = col - Math.floor(width / 2);
  const positions = [
    [centered, row + 1],
    [centered, row - height],
    [col + 2, row - Math.floor(height / 2)],
    [col - 1 - width, row - Math.floor(height / 2)],
  ] as const;
  const [left, top] = positions[slot];
  const box = { left, top, width, height };
  return {
    label,
    slot,
    box,
    textBounds: box,
    lines,
    width,
    collision: { ...box, left: left - 1, width: width + 2 },
  };
}

/** Eligibility excludes collisions: a competing label must not decide which tile copy wins. */
export function labelFitsArea(
  label: LabelCandidate,
  area: LabelArea,
  aspect = 1.8,
  kept = false,
): boolean {
  const allowed = retentionArea(area, kept);
  return labelSlots(label.mode).some((slot) => {
    const layout = slotLayout(label, slot, aspect);
    return layout !== undefined && inside(layout.box, allowed);
  });
}

/** Visibility for copy selection and the accessible visible-label list; no halo-only names. */
export function labelTouchesArea(
  label: LabelCandidate,
  area: LabelArea,
  aspect = 1.8,
  slot?: LabelSlot,
): boolean {
  const remembered = slot !== undefined && slotLayout(label, slot, aspect);
  if (remembered) return labelIntersectsArea(remembered.textBounds, area);
  return labelSlots(label.mode).some((choice) => {
    const layout = slotLayout(label, choice, aspect);
    return layout !== undefined && labelIntersectsArea(layout.textBounds, area);
  });
}

/** Reserve layouts first; labels.ts writes glyphs using the accepted layout and the same dissolve. */
export function layoutLabels(
  overlay: Overlay,
  candidates: readonly LabelCandidate[],
  area: LabelArea,
  aspect: number,
  stability: PlaceStability,
  repeatDistance: (rank: number) => number,
): LabelLayout[] {
  const accepted: LabelLayout[] = [];
  const names = new Map<string, { col: number; row: number }[]>();
  for (const label of orderLabels(candidates, stability)) {
    const nearby = names.get(label.text) ?? [];
    if (
      nearby.some(
        (p) =>
          Math.hypot(p.col - label.col, (p.row - label.row) * aspect) < repeatDistance(label.rank),
      )
    )
      continue;
    const allowed = retentionArea(area, stability.memory?.has(label.id) ?? false);
    for (const slot of labelSlots(label.mode, stability.memory?.get(label.id))) {
      const layout = slotLayout(label, slot, aspect);
      if (!layout || !inside(layout.box, allowed) || isTaken(overlay, layout.collision)) continue;
      take(overlay, layout.collision);
      if (!nearby.length) names.set(label.text, nearby);
      nearby.push({ col: label.col, row: label.row });
      accepted.push(layout);
      break;
    }
  }
  if (stability.memory) {
    stability.memory.clear();
    for (const { label, slot } of accepted) stability.memory.set(label.id, slot);
  }
  return accepted;
}

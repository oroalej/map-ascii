import type { LabelArea, LabelCandidate, Overlay } from './labels';
import {
  labelSlots,
  orderLabels,
  retentionArea,
  type LabelSlot,
  type PlaceStability,
} from './label-stability';

export type Box = { left: number; top: number; width: number; height: number };
function copyBox(out: Box, box: Box) {
  out.left = box.left;
  out.top = box.top;
  out.width = box.width;
  out.height = box.height;
}
/** Collision cells reach past the grid by at least the retained overhang plus its halo. */
export const TAKEN_PAD = 4;
export const LABEL_WIDTH = 18;
/** Shared by rotated collision geometry and pointer coverage. */
export const ROTATED_HALO_HEIGHT = 1.4;

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
  box.left < area.right &&
  area.left < box.left + box.width &&
  box.top < area.bottom &&
  area.top < box.top + box.height;

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
  // Keep the full box in the list even beyond the pad: out-of-grid queries use that list.
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

type TextMetrics = {
  lines: string[];
  width: number;
  trimmed: string;
  length: number;
  chars?: string[];
};
const wrapped = new Map<string, TextMetrics>();
const WRAPPED_MAX = 20_000;
function characterCount(text: string): number {
  let count = 0;
  for (let offset = 0; offset < text.length; count++) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}
function wrapOnce(text: string) {
  let found = wrapped.get(text);
  if (!found) {
    const lines = wrapText(text);
    const trimmed = text.trim();
    found = {
      lines,
      width: Math.max(0, ...lines.map(characterCount)),
      trimmed,
      length: characterCount(trimmed),
    };
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
  out: Box,
): Box {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const w = c * width + s * aspect * height,
    h = (s * width) / aspect + c * height;
  out.left = col + 0.5 - w / 2;
  out.top = row + 0.5 - h / 2;
  out.width = w;
  out.height = h;
  return out;
}

export function rotatedLabelBox(
  col: number,
  row: number,
  width: number,
  angle: number,
  aspect = 1.8,
  out: Box = { left: 0, top: 0, width: 0, height: 0 },
): Box {
  const c = Math.abs(Math.cos(angle)),
    s = Math.abs(Math.sin(angle));
  const w = c * (width + 2) + s * aspect * ROTATED_HALO_HEIGHT;
  const h = (s * (width + 2)) / aspect + c * ROTATED_HALO_HEIGHT;
  const left = Math.floor(col + 0.5 - w / 2),
    top = Math.floor(row + 0.5 - h / 2);
  out.left = left;
  out.top = top;
  out.width = Math.ceil(col + 0.5 + w / 2) - left;
  out.height = Math.ceil(row + 0.5 + h / 2) - top;
  return out;
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

/** Shared numeric geometry; fit checks never construct glyph arrays or full layouts. */
function measureSlot(
  label: LabelCandidate,
  slot: LabelSlot,
  aspect: number,
  box: Box,
  textBounds?: Box,
): boolean {
  const { col, row } = label;
  const metrics = wrapOnce(label.text);
  if (slot === -1) {
    if (
      label.mode !== 'rotated' ||
      !metrics.length ||
      (label.runCells !== undefined && metrics.length + 2 > label.runCells)
    )
      return false;
    const angle = uprightStreetAngle(label.angle ?? 0);
    rotatedLabelBox(col, row, metrics.length, angle, aspect, box);
    if (textBounds) rotatedBounds(col, row, metrics.length, 1, angle, aspect, textBounds);
    return true;
  }
  const { lines, width } = metrics;
  if (!lines.length || !lines[0]) return false;
  const height = lines.length,
    centered = col - Math.floor(width / 2);
  box.left = slot < 2 ? centered : slot === 2 ? col + 2 : col - 1 - width;
  box.top = slot === 0 ? row + 1 : slot === 1 ? row - height : row - Math.floor(height / 2);
  box.width = width;
  box.height = height;
  if (textBounds) copyBox(textBounds, box);
  return true;
}

// Eligibility is synchronous. These boxes never escape into accepted layouts or collisions.
const fitBox: Box = { left: 0, top: 0, width: 0, height: 0 };
const fitText: Box = { ...fitBox };

/** Eligibility excludes collisions: a competing label must not decide which tile copy wins. */
export function labelFitsArea(
  label: LabelCandidate,
  area: LabelArea,
  aspect = 1.8,
  kept = false,
): boolean {
  const allowed = retentionArea(area, kept);
  return labelSlots(label.mode).some((slot) => {
    return measureSlot(label, slot, aspect, fitBox) && inside(fitBox, allowed);
  });
}

/** Visibility of the first admissible slot before collisions; text bounds exclude halos. */
export function labelTouchesArea(
  label: LabelCandidate,
  screen: LabelArea,
  allowed: LabelArea,
  aspect = 1.8,
  slot?: LabelSlot,
): boolean {
  for (const choice of labelSlots(label.mode, slot)) {
    if (measureSlot(label, choice, aspect, fitBox, fitText) && inside(fitBox, allowed))
      return labelIntersectsArea(fitText, screen);
  }
  return false;
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
  const box: Box = { left: 0, top: 0, width: 0, height: 0 };
  const textBounds = { ...box },
    collision = { ...box };
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
      if (!measureSlot(label, slot, aspect, box, textBounds) || !inside(box, allowed)) continue;
      copyBox(collision, box);
      if (slot !== -1) {
        collision.left--;
        collision.width += 2;
      }
      if (isTaken(overlay, collision)) continue;
      const metrics = wrapOnce(label.text);
      const ownedBox = { ...box };
      const layout: LabelLayout =
        slot === -1
          ? {
              label,
              slot,
              box: ownedBox,
              collision: ownedBox,
              textBounds: { ...textBounds },
              chars: (metrics.chars ??= [...metrics.trimmed]),
              angle: uprightStreetAngle(label.angle ?? 0),
            }
          : {
              label,
              slot,
              box: ownedBox,
              collision: { ...collision },
              textBounds: ownedBox,
              lines: metrics.lines,
              width: metrics.width,
            };
      take(overlay, layout.collision);
      if (labelIntersectsArea(layout.textBounds, stability.screen ?? area)) {
        if (!nearby.length) names.set(label.text, nearby);
        nearby.push({ col: label.col, row: label.row });
      }
      accepted.push(layout);
      break;
    }
  }
  if (stability.memory && stability.commitMemory !== false) {
    stability.memory.clear();
    for (const { label, slot } of accepted) stability.memory.set(label.id, slot);
  }
  return accepted;
}

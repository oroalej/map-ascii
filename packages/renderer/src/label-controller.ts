import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { screenArea, type Grid, type GridPlacement, type View } from './grid';
import { labelCandidate, labelScreenArea } from './label-candidates';
import { collectLabel } from './label-collection';
import { labelFitsArea, labelTouchesArea } from './label-layout';
import { labelFocus, placementArea, retentionArea } from './label-stability';
import type { LabelArea, LabelCandidate } from './labels';
import {
  forgetLabelPlacement,
  labelMemory,
  labelOverlayChanged,
  labelsInView,
  overlayPass,
  transferLabelPlacement,
} from './passes';
import type { TileLabel } from './raster/geometry';

const noFocus: readonly number[] = [];
export type LabelSource = { labels: readonly TileLabel[]; zoom: number };

/** The labels from the last tile draw, so focus can replace only the overlay. */
export class AtlasLabels {
  private labels = new Map<number, TileLabel>();
  private visible: LabelCandidate[] = [];
  private targets: CellTargets | undefined;
  private labelWidth = 0;
  private labelHeight = 0;
  private candidates = new Map<number, LabelCandidate>();
  private prepared: LabelCandidate[] = [];
  private copies = new Map<TileLabel, LabelCandidate | undefined>();
  private sourceZooms = new Map<TileLabel, number>();
  private copyVisible = new Map<TileLabel, boolean>();
  private previous = new Map<number, TileLabel>();
  private admission = {
    area: { left: 0, top: 0, right: 0, bottom: 0 },
    retained: { left: 0, top: 0, right: 0, bottom: 0 },
    aspect: 1.8,
  };
  private screen: LabelArea = { left: 0, top: 0, right: 0, bottom: 0 };
  private placement: GridPlacement | undefined;
  private focused: readonly number[] = [];
  private observed = false;
  private observedArea = { left: 0, top: 0, right: 0, bottom: 0 };
  private inputs:
    | {
        selected: number;
        hover: number;
        originCol: number;
        originRow: number;
        shiftX: number;
        shiftY: number;
        left: number;
        top: number;
        right: number;
        bottom: number;
        zoom: number;
        width: number;
        height: number;
        dpr: number;
        w: number;
        h: number;
      }
    | undefined;

  collect(
    targets: CellTargets,
    view: View,
    placement: GridPlacement,
    sources: Iterable<LabelSource>,
  ): void {
    if (this.targets !== targets) {
      if (
        this.targets &&
        this.targets.labelCols === targets.labelCols &&
        this.targets.labelRows === targets.labelRows &&
        this.labelWidth === view.labelDev.w &&
        this.labelHeight === view.labelDev.h
      )
        transferLabelPlacement(this.targets, targets);
      else this.clear();
    }
    this.targets = targets;
    this.labelWidth = view.labelDev.w;
    this.labelHeight = view.labelDev.h;
    this.placement = placement;
    this.observed = false;
    this.clearCopies();
    const memory = labelMemory(targets);
    for (const [id, label] of this.labels) if (memory?.has(id)) this.previous.set(id, label);
    this.prepareAdmission(view, placement.grid);
    this.screen = labelScreenArea(view, placement.grid);
    for (const { labels, zoom } of sources) {
      for (const label of labels) {
        if (!this.copies.has(label))
          this.copies.set(label, labelCandidate(label, view, placement, this.admission.area));
        this.sourceZooms.set(label, Math.max(this.sourceZooms.get(label) ?? -Infinity, zoom));
      }
    }
    this.labels.clear();
    for (const [label, candidate] of this.copies) {
      if (this.fits(candidate, memory?.has(label.id) ?? false))
        collectLabel(
          this.labels,
          label,
          this.previous.get(label.id),
          this.onScreen,
          this.sourceZoom,
        );
    }
    this.candidates.clear();
    this.prepared.length = 0;
    for (const [id, label] of this.labels) {
      const prepared = this.copies.get(label);
      if (prepared) {
        this.candidates.set(id, prepared);
        this.prepared.push(prepared);
      }
    }
    // Layout applies its own priorities. Reporting keeps the ordinary rank/id order.
    this.prepared.sort((a, b) => a.rank - b.rank || a.id - b.id);
    this.clearCopies();
  }

  private clearCopies(): void {
    this.copies.clear();
    this.sourceZooms.clear();
    this.copyVisible.clear();
    this.previous.clear();
  }

  private prepareAdmission(view: View, grid: Grid): void {
    screenArea(view, grid, view.labelDev, this.admission.area);
    retentionArea(this.admission.area, this.admission.retained);
    this.admission.aspect = view.labelDev.h / view.labelDev.w;
  }

  private fits(candidate: LabelCandidate | undefined, kept: boolean): boolean {
    return (
      candidate !== undefined &&
      labelFitsArea(
        candidate,
        placementArea(this.admission.area, this.admission.retained, kept),
        this.admission.aspect,
      )
    );
  }

  private onScreen = (label: TileLabel): boolean => {
    const known = this.copyVisible.get(label);
    if (known !== undefined) return known;
    const candidate = this.copies.get(label);
    const previous = this.targets && labelMemory(this.targets)?.get(label.id);
    const visible =
      candidate !== undefined &&
      labelTouchesArea(
        candidate,
        this.screen,
        placementArea(this.admission.area, this.admission.retained, previous !== undefined),
        this.admission.aspect,
        previous?.slot,
      );
    this.copyVisible.set(label, visible);
    return visible;
  };

  private sourceZoom = (label: TileLabel): number => this.sourceZooms.get(label) ?? 0;

  private focus(
    targets: CellTargets,
    view: View,
    grid: Grid,
    selected: number,
    hover: number,
  ): readonly number[] {
    if (selected <= 0 && hover <= 0) return noFocus;
    const memory = labelMemory(targets);
    this.prepareAdmission(view, grid);
    return labelFocus(selected, hover, (id) =>
      this.fits(this.candidates.get(id), memory?.has(id) ?? false),
    );
  }

  /** Record misses too: an ineligible focus must not repeat geometry work every frame. */
  private observe(view: View, grid: Grid, selected: number, hover: number): boolean {
    const old = this.inputs;
    const sameView =
      old !== undefined &&
      old.originCol === grid.originCol &&
      old.originRow === grid.originRow &&
      old.zoom === view.camera.zoom &&
      old.width === view.width &&
      old.height === view.height &&
      old.dpr === view.dpr &&
      old.w === view.labelDev.w &&
      old.h === view.labelDev.h;
    const sameFocus = old?.selected === selected && old.hover === hover;
    if (
      this.observed &&
      sameView &&
      sameFocus &&
      old.shiftX === grid.shiftX &&
      old.shiftY === grid.shiftY
    )
      return false;
    const area =
      selected > 0 || hover > 0
        ? screenArea(view, grid, view.labelDev, this.observedArea)
        : undefined;
    const left = area?.left ?? 0,
      top = area?.top ?? 0,
      right = area?.right ?? 0,
      bottom = area?.bottom ?? 0;
    const changed =
      !this.observed ||
      !sameView ||
      !sameFocus ||
      old?.left !== left ||
      old.top !== top ||
      old.right !== right ||
      old.bottom !== bottom;
    const inputs = (this.inputs ??= {
      selected: 0,
      hover: 0,
      originCol: 0,
      originRow: 0,
      shiftX: 0,
      shiftY: 0,
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      zoom: 0,
      width: 0,
      height: 0,
      dpr: 0,
      w: 0,
      h: 0,
    });
    inputs.selected = selected;
    inputs.hover = hover;
    inputs.originCol = grid.originCol;
    inputs.originRow = grid.originRow;
    inputs.shiftX = grid.shiftX;
    inputs.shiftY = grid.shiftY;
    inputs.left = left;
    inputs.top = top;
    inputs.right = right;
    inputs.bottom = bottom;
    inputs.zoom = view.camera.zoom;
    inputs.width = view.width;
    inputs.height = view.height;
    inputs.dpr = view.dpr;
    inputs.w = view.labelDev.w;
    inputs.h = view.labelDev.h;
    this.observed = true;
    return changed;
  }

  draw(
    gl: GL,
    targets: CellTargets,
    theme: ThemeResources,
    view: View,
    placement: GridPlacement,
    programs: Programs,
    selected: number,
    hover: number,
    commitMemory = true,
    focus = this.focus(targets, view, placement.grid, selected, hover),
  ): TileLabel[] {
    this.observe(view, placement.grid, selected, hover);
    overlayPass(gl, targets, theme, view, placement, this.prepared, programs, focus, commitMemory);
    this.focused = focus;
    return this.inView(targets, view, placement.grid);
  }

  relabel(
    gl: GL,
    targets: CellTargets,
    theme: ThemeResources,
    view: View,
    programs: Programs,
    selected: number,
    hover: number,
    grid: Grid,
  ): TileLabel[] | undefined {
    if (!this.placement || !this.observe(view, grid, selected, hover)) return;
    const focus = this.focus(targets, view, grid, selected, hover);
    if (focus.length === this.focused.length && focus.every((id, i) => id === this.focused[i]))
      return;
    const placement = { ...this.placement, grid };
    const labels = this.draw(
      gl,
      targets,
      theme,
      view,
      placement,
      programs,
      selected,
      hover,
      false,
      focus,
    );
    return labelOverlayChanged(targets) ? labels : undefined;
  }

  inView(targets: CellTargets, view: View, grid: Grid): TileLabel[] {
    const labels: TileLabel[] = [];
    for (const { id } of labelsInView(targets, view, grid, this.prepared, this.visible)) {
      const label = this.labels.get(id);
      if (label) labels.push(label);
    }
    return labels;
  }

  clear(): void {
    if (this.targets) forgetLabelPlacement(this.targets);
    this.targets = undefined;
    this.labelWidth = 0;
    this.labelHeight = 0;
    this.labels.clear();
    this.visible.length = 0;
    this.candidates.clear();
    this.prepared.length = 0;
    this.clearCopies();
    this.placement = undefined;
    this.inputs = undefined;
    this.observed = false;
    this.focused = [];
  }
}

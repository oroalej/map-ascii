import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { screenArea, type Grid, type GridPlacement, type View } from './grid';
import { labelCandidate, labelScreenArea } from './label-candidates';
import { collectLabels } from './label-collection';
import { labelFitsArea, labelTouchesArea } from './label-layout';
import { labelFocus, placementArea, retentionArea } from './label-stability';
import type { LabelCandidate } from './labels';
import {
  forgetLabelPlacement,
  labelMemory,
  labelOverlayChanged,
  labelsInView,
  overlayPass,
} from './passes';
import type { TileLabel } from './raster/geometry';

const noFocus: readonly number[] = [];
export type LabelSource = { labels: readonly TileLabel[]; zoom: number };

/** The labels from the last tile draw, so focus can replace only the overlay. */
export class AtlasLabels {
  private labels = new Map<number, TileLabel>();
  private visible: LabelCandidate[] = [];
  private targets: CellTargets | undefined;
  private candidates = new Map<number, LabelCandidate>();
  private prepared: LabelCandidate[] = [];
  private placement: GridPlacement | undefined;
  private focused: readonly number[] = [];
  private observed = false;
  private inputs:
    | {
        selected: number;
        hover: number;
        originCol: number;
        originRow: number;
        shiftX: number;
        shiftY: number;
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
    if (this.targets !== targets) this.clear();
    this.targets = targets;
    this.placement = placement;
    this.observed = false;
    const memory = labelMemory(targets);
    const previous = new Map<number, TileLabel>();
    for (const [id, label] of this.labels) if (memory?.has(id)) previous.set(id, label);
    const area = screenArea(view, placement.grid, view.labelDev),
      screen = labelScreenArea(view, placement.grid),
      retained = retentionArea(area);
    const aspect = view.labelDev.h / view.labelDev.w;
    const candidates = new Map<
      TileLabel,
      { candidate: LabelCandidate | undefined; zoom: number }
    >();
    function* copies() {
      for (const { labels, zoom } of sources) {
        for (const label of labels) {
          const known = candidates.get(label);
          if (known) known.zoom = Math.max(known.zoom, zoom);
          else
            candidates.set(label, {
              candidate: labelCandidate(label, view, placement, area),
              zoom,
            });
          yield label;
        }
      }
    }
    const candidate = (label: TileLabel) => candidates.get(label)?.candidate;
    const visible = new Map<TileLabel, boolean>();
    this.labels = collectLabels(
      copies(),
      previous,
      (label) => {
        const prepared = candidate(label);
        return (
          prepared !== undefined &&
          labelFitsArea(
            prepared,
            placementArea(area, retained, memory?.has(label.id) ?? false),
            aspect,
          )
        );
      },
      (label) => {
        const known = visible.get(label);
        if (known !== undefined) return known;
        const prepared = candidate(label);
        const onScreen =
          prepared !== undefined &&
          labelTouchesArea(
            prepared,
            screen,
            placementArea(area, retained, memory?.has(label.id) ?? false),
            aspect,
            memory?.get(label.id)?.slot,
          );
        visible.set(label, onScreen);
        return onScreen;
      },
      (label) => candidates.get(label)!.zoom,
    );
    this.candidates.clear();
    this.prepared = [];
    for (const [id, label] of this.labels) {
      const prepared = candidate(label);
      if (prepared) {
        this.candidates.set(id, prepared);
        this.prepared.push(prepared);
      }
    }
    // Layout applies its own priorities. Reporting keeps the ordinary rank/id order.
    this.prepared.sort((a, b) => a.rank - b.rank || a.id - b.id);
  }

  private focus(
    targets: CellTargets,
    view: View,
    grid: Grid,
    selected: number,
    hover: number,
  ): readonly number[] {
    if (selected <= 0 && hover <= 0) return noFocus;
    const memory = labelMemory(targets),
      area = screenArea(view, grid, view.labelDev),
      retained = retentionArea(area);
    return labelFocus(selected, hover, (id) => {
      const candidate = this.candidates.get(id);
      return (
        candidate !== undefined &&
        labelFitsArea(
          candidate,
          placementArea(area, retained, memory?.has(id) ?? false),
          view.labelDev.h / view.labelDev.w,
        )
      );
    });
  }

  /** Record misses too: an ineligible focus must not repeat geometry work every frame. */
  private observe(view: View, grid: Grid, selected: number, hover: number): boolean {
    const old = this.inputs;
    if (
      this.observed &&
      old &&
      old.selected === selected &&
      old.hover === hover &&
      old.originCol === grid.originCol &&
      old.originRow === grid.originRow &&
      old.shiftX === grid.shiftX &&
      old.shiftY === grid.shiftY &&
      old.zoom === view.camera.zoom &&
      old.width === view.width &&
      old.height === view.height &&
      old.dpr === view.dpr &&
      old.w === view.labelDev.w &&
      old.h === view.labelDev.h
    )
      return false;
    const inputs = (this.inputs ??= {
      selected: 0,
      hover: 0,
      originCol: 0,
      originRow: 0,
      shiftX: 0,
      shiftY: 0,
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
    inputs.zoom = view.camera.zoom;
    inputs.width = view.width;
    inputs.height = view.height;
    inputs.dpr = view.dpr;
    inputs.w = view.labelDev.w;
    inputs.h = view.labelDev.h;
    this.observed = true;
    return true;
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
    this.labels.clear();
    this.visible.length = 0;
    this.candidates.clear();
    this.prepared = [];
    this.placement = undefined;
    this.inputs = undefined;
    this.observed = false;
    this.focused = [];
  }
}

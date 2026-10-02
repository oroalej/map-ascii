import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { screenArea, type Grid, type GridPlacement, type View } from './grid';
import { labelCandidate, labelScreenArea } from './label-candidates';
import { collectLabels } from './label-collection';
import { labelFitsArea, labelTouchesArea } from './label-layout';
import { labelFocus, retentionArea } from './label-stability';
import type { LabelCandidate } from './labels';
import { forgetLabelPlacement, labelMemory, labelsInView, overlayPass } from './passes';
import type { TileLabel } from './raster/geometry';

/** The labels from the last tile draw, so focus can replace only the overlay. */
export class AtlasLabels {
  private labels = new Map<number, TileLabel>();
  private placed: LabelCandidate[] = [];
  private targets: CellTargets | undefined;
  private candidates = new Map<number, LabelCandidate>();
  private prepared: LabelCandidate[] = [];
  private placement: GridPlacement | undefined;
  private focused: readonly number[] = [];
  private inputs:
    | {
        selected: number;
        hover: number;
        grid: Grid;
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
    labels: Iterable<TileLabel>,
  ): void {
    if (this.targets !== targets) this.clear();
    this.targets = targets;
    this.placement = placement;
    this.inputs = undefined;
    const memory = labelMemory(targets);
    const previous = new Map([...this.labels].filter(([id]) => memory?.has(id)));
    const area = screenArea(view, placement.grid, view.labelDev),
      screen = labelScreenArea(view, placement.grid);
    const aspect = view.labelDev.h / view.labelDev.w;
    const candidates = new Map<TileLabel, LabelCandidate | undefined>();
    const candidate = (label: TileLabel) => {
      if (!candidates.has(label))
        candidates.set(label, labelCandidate(label, view, placement, area));
      return candidates.get(label);
    };
    const visible = new Map<TileLabel, boolean>();
    this.labels = collectLabels(
      labels,
      previous,
      (label) => {
        const prepared = candidate(label);
        return (
          prepared !== undefined &&
          labelFitsArea(prepared, area, aspect, memory?.has(label.id) ?? false)
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
            retentionArea(area, memory?.has(label.id) ?? false),
            aspect,
            memory?.get(label.id),
          );
        visible.set(label, onScreen);
        return onScreen;
      },
    );
    this.candidates.clear();
    this.prepared = [];
    for (const [id, label] of this.labels) {
      const prepared = candidates.get(label);
      if (prepared) {
        this.candidates.set(id, prepared);
        this.prepared.push(prepared);
      }
    }
  }

  private focus(
    targets: CellTargets,
    view: View,
    grid: Grid,
    selected: number,
    hover: number,
  ): number[] {
    const memory = labelMemory(targets),
      area = screenArea(view, grid, view.labelDev);
    return labelFocus(selected, hover, (id) => {
      const candidate = this.candidates.get(id);
      return (
        candidate !== undefined &&
        labelFitsArea(candidate, area, view.labelDev.h / view.labelDev.w, memory?.has(id) ?? false)
      );
    });
  }

  /** Record misses too: an ineligible focus must not repeat geometry work every frame. */
  private observe(view: View, grid: Grid, selected: number, hover: number): boolean {
    const old = this.inputs;
    if (
      old &&
      old.selected === selected &&
      old.hover === hover &&
      old.grid.originCol === grid.originCol &&
      old.grid.originRow === grid.originRow &&
      old.grid.shiftX === grid.shiftX &&
      old.grid.shiftY === grid.shiftY &&
      old.zoom === view.camera.zoom &&
      old.width === view.width &&
      old.height === view.height &&
      old.dpr === view.dpr &&
      old.w === view.labelDev.w &&
      old.h === view.labelDev.h
    )
      return false;
    this.inputs = {
      selected,
      hover,
      grid: { ...grid },
      zoom: view.camera.zoom,
      width: view.width,
      height: view.height,
      dpr: view.dpr,
      w: view.labelDev.w,
      h: view.labelDev.h,
    };
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
    this.placed = overlayPass(
      gl,
      targets,
      theme,
      view,
      placement,
      this.prepared,
      programs,
      focus,
      commitMemory,
    );
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
  ): { labels: TileLabel[]; grid: Grid } | undefined {
    if (!this.placement || !this.observe(view, grid, selected, hover)) return;
    const focus = this.focus(targets, view, grid, selected, hover);
    if (focus.length === this.focused.length && focus.every((id, i) => id === this.focused[i]))
      return;
    const placement = { ...this.placement, grid };
    return {
      labels: this.draw(
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
      ),
      grid: placement.grid,
    };
  }

  inView(targets: CellTargets, view: View, grid: Grid): TileLabel[] {
    return labelsInView(targets, view, grid, this.placed).flatMap(
      ({ id }) => this.labels.get(id) ?? [],
    );
  }

  clear(): void {
    if (this.targets) forgetLabelPlacement(this.targets);
    this.targets = undefined;
    this.labels.clear();
    this.placed = [];
    this.candidates.clear();
    this.prepared = [];
    this.placement = undefined;
    this.inputs = undefined;
    this.focused = [];
  }
}

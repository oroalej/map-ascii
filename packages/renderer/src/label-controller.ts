import type { CellTargets, GL } from './gpu';
import type { Programs, ThemeResources } from './gpu-context';
import { placeGrid, type Grid, type GridPlacement, type View } from './grid';
import { labelArea, labelCandidate, labelScreenArea } from './label-candidates';
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
  private focusKey = '';

  collect(
    targets: CellTargets,
    view: View,
    placement: GridPlacement,
    labels: Iterable<TileLabel>,
  ): void {
    if (this.targets !== targets) this.clear();
    this.targets = targets;
    const memory = labelMemory(targets);
    const previous = new Map([...this.labels].filter(([id]) => memory?.has(id)));
    const area = labelArea(view, placement),
      screen = labelScreenArea(view, placement.grid);
    const aspect = view.labelDev.h / view.labelDev.w;
    const candidates = new Map<TileLabel, LabelCandidate | undefined>();
    const candidate = (label: TileLabel) => {
      if (!candidates.has(label)) candidates.set(label, labelCandidate(label, view, placement));
      return candidates.get(label);
    };
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
        const prepared = candidate(label);
        return (
          prepared !== undefined &&
          labelTouchesArea(
            prepared,
            screen,
            retentionArea(area, memory?.has(label.id) ?? false),
            aspect,
            memory?.get(label.id),
          )
        );
      },
    );
  }

  private focus(
    targets: CellTargets,
    view: View,
    placement: GridPlacement,
    selected: number,
    hover: number,
  ): number[] {
    const memory = labelMemory(targets),
      area = labelArea(view, placement);
    return labelFocus(selected, hover, (id) => {
      const label = this.labels.get(id);
      const candidate = label && labelCandidate(label, view, placement);
      return (
        candidate !== undefined &&
        labelFitsArea(candidate, area, view.labelDev.h / view.labelDev.w, memory?.has(id) ?? false)
      );
    });
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
  ): TileLabel[] {
    const focus = this.focus(targets, view, placement, selected, hover);
    this.placed = overlayPass(
      gl,
      targets,
      theme,
      view,
      placement,
      this.labels.values(),
      programs,
      focus,
    );
    this.focusKey = focus.join(',');
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
  ): { labels: TileLabel[]; grid: Grid } | undefined {
    const placement = placeGrid(view, view.labelDev, targets.labelCols, targets.labelRows);
    if (this.focus(targets, view, placement, selected, hover).join(',') === this.focusKey) return;
    return {
      labels: this.draw(gl, targets, theme, view, placement, programs, selected, hover),
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
    this.focusKey = '';
  }
}

/** Viewer-local Life time and a coherent held frame; no simulation or DOM dependencies. */
export class LifePause<T> {
  private at: number;
  private running: boolean;
  private elapsed = 0;
  private accepted = 0;
  private held: T | undefined;
  private heldAt = 0;
  private paused = 0;

  constructor(at: number, running = true) {
    this.at = at;
    this.running = running;
  }

  tick(at: number, running = this.running) {
    if (this.running && !this.inspecting) this.elapsed += Math.max(0, at - this.at) / 1000;
    this.at = at;
    if (running !== this.running) this.accepted = this.elapsed;
    this.running = running;
    return this.elapsed;
  }

  get time() {
    return this.elapsed;
  }

  get delta() {
    return this.elapsed - this.accepted;
  }

  accept() {
    this.accepted = this.elapsed;
  }

  get inspecting() {
    return this.held !== undefined;
  }

  pause(frame: T | undefined, at: number) {
    if (this.inspecting || frame === undefined) return;
    this.held = frame;
    this.heldAt = at;
  }

  resume(at: number) {
    if (!this.inspecting) return;
    this.tick(at);
    this.paused += Math.max(0, at - this.heldAt) / 1000;
    this.held = undefined;
    this.accept();
  }

  view(latest: T | undefined) {
    return this.held ?? latest;
  }

  /** Hover time only, for the current scheduled procession's visual delay. */
  pausedSeconds(at: number) {
    return this.paused + (this.inspecting ? Math.max(0, at - this.heldAt) / 1000 : 0);
  }
}

/** Real-time event eligibility is separate from its viewer-local, delayed visual progress. */
export class LivePauseOffset {
  private occurrence: string | undefined;
  private baseline = 0;

  reset() {
    this.occurrence = undefined;
  }

  progress(occurrence: string, progress: number, duration: number, pausedSeconds: number) {
    if (occurrence !== this.occurrence) {
      this.occurrence = occurrence;
      this.baseline = pausedSeconds;
    }
    return Math.max(0, progress - (pausedSeconds - this.baseline) / duration);
  }
}

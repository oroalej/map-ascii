import type { GL } from './gpu';

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export const GPU_SAMPLE_MS = 250;
export const MAX_GPU_QUERIES = 4;

/** Optional GPU elapsed queries. Never read a result until the browser says it is ready. */
export class GpuTimer {
  private readonly extension: TimerExtension | null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private lastSample = -Infinity;
  private average: number | null = null;

  constructor(
    private readonly gl: GL,
    enabled: boolean,
  ) {
    this.extension = enabled
      ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null)
      : null;
  }

  get milliseconds() {
    return this.average;
  }

  begin(now: number) {
    const ext = this.extension;
    if (
      !ext ||
      this.active ||
      this.pending.length >= MAX_GPU_QUERIES ||
      now - this.lastSample < GPU_SAMPLE_MS
    )
      return;
    if (this.gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      this.reset();
      return;
    }
    const query = this.gl.createQuery();
    if (!query) return;
    this.lastSample = now;
    this.active = query;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
  }

  end() {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  poll() {
    if (!this.extension || this.pending.length === 0) return;
    const gl = this.gl;
    if (gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.reset();
      return;
    }
    while (this.pending.length) {
      const query = this.pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1_000_000;
      if (Number.isFinite(ms) && ms >= 0)
        this.average = this.average === null ? ms : this.average + 0.1 * (ms - this.average);
      gl.deleteQuery(query);
      this.pending.shift();
    }
  }

  reset(lost = false) {
    if (!lost) {
      if (this.active && this.extension) {
        this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
        this.gl.deleteQuery(this.active);
      }
      for (const query of this.pending) this.gl.deleteQuery(query);
    }
    this.active = null;
    this.pending.length = 0;
    this.average = null;
    this.lastSample = -Infinity;
  }
}

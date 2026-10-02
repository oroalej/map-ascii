/** Sparse clock tokens: Life owns ink/R and lighting owns winning pools/G. */
export class EffectClocks {
  readonly values: Float32Array;
  revision = 0;
  private channels: {
    epoch: number;
    stamps: Uint32Array;
    tokens: Float32Array;
    current: number[];
    next: number[];
  }[];

  constructor(cells: number) {
    this.values = new Float32Array(cells * 2).fill(-1);
    this.channels = [0, 1].map(() => ({
      epoch: 0,
      stamps: new Uint32Array(cells),
      tokens: new Float32Array(cells),
      current: [],
      next: [],
    }));
  }

  get active() {
    return this.channels.some((channel) => channel.current.length > 0);
  }

  begin(channel: 0 | 1) {
    const state = this.channels[channel]!;
    state.epoch = (state.epoch + 1) >>> 0;
    if (!state.epoch) {
      state.stamps.fill(0);
      state.epoch = 1;
    }
    state.next.length = 0;
  }

  set(channel: 0 | 1, cell: number, token: number) {
    const state = this.channels[channel]!;
    if (state.stamps[cell] !== state.epoch) {
      // An ordinary winner needs no token unless it replaces a token this pass.
      if (token === -1) return;
      state.stamps[cell] = state.epoch;
      state.next.push(cell);
    }
    state.tokens[cell] = token;
  }

  finish(channel: 0 | 1) {
    const state = this.channels[channel]!;
    let changed = false;
    for (const cell of state.current) {
      if (state.stamps[cell] === state.epoch) continue;
      this.values[cell * 2 + channel] = -1;
      changed = true;
    }
    let count = 0;
    for (const cell of state.next) {
      const token = state.tokens[cell]!;
      const at = cell * 2 + channel;
      if (this.values[at] !== token) {
        this.values[at] = token;
        changed = true;
      }
      if (token !== -1) state.next[count++] = cell;
    }
    state.next.length = count;
    [state.current, state.next] = [state.next, state.current];
    if (changed) this.revision++;
  }

  /** Reused pool writer, invoked only when a pool wins a cell. */
  pool = (cell: number, token: number) => this.set(1, cell, token);
}

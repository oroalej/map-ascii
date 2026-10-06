/** A physical three-read lease. Logical controller resets cannot retire live GPU reads. */
export class CueReadback {
  private token?: object;
  private gpu = new Float64Array(8);
  private cursor = 0;
  private speechDue = false;
  private speechExpiry = Infinity;
  private budget = 200;
  get busy() {
    return !!this.token;
  }
  speechWork(due: boolean, expiry = Infinity) {
    this.speechDue = due;
    this.speechExpiry = expiry;
  }
  acquire(kind: 'speech' | 'emoji', now: number): (() => void) | undefined {
    if (
      this.token ||
      (kind === 'emoji' && (this.speechDue || now + 2 * this.budget + 100 >= this.speechExpiry))
    )
      return;
    const token = {};
    this.token = token;
    return () => {
      if (this.token !== token) return;
      this.token = undefined;
    };
  }
  completed(latency: number) {
    this.gpu[this.cursor++ % this.gpu.length] = latency;
    this.budget = Math.max(100, ...this.gpu);
  }
}

/**
 * Asynchronous reads from the GPU (ARCHITECTURE.md §3 step 7). `readPixels` into a pixel-pack
 * buffer returns at once, and a fence tells us when the GPU has written the buffer. Only then is
 * the data copied out, so the main thread never waits for the GPU (a plain `readPixels` does,
 * once per pointer move). Results arrive a frame or two later.
 */
import type { GL } from './gpu';

export type ReadRect = { x: number; y: number; width: number; height: number };

type Pending = {
  sync: WebGLSync;
  buffer: PackBuffer;
  bytes: number;
  done: (data: Uint8Array) => void;
};

type PackBuffer = { handle: WebGLBuffer; capacity: number };

/** Reads still waiting for the GPU beyond this are dropped, oldest first. */
export const MAX_PENDING_READS = 8;

export class Readback {
  private pending: Pending[] = [];
  private free: PackBuffer[] = [];

  constructor(private readonly gl: GL) {}

  /** Number of reads waiting for the GPU. */
  get size() {
    return this.pending.length;
  }

  /**
   * Queue a read of `rect` (texels, from the bottom left) from color `attachment` of `fbo`, as
   * RGBA bytes (the format WebGL2 always supports). `done` gets the bytes from a later `poll`.
   */
  request(
    fbo: WebGLFramebuffer,
    attachment: number,
    rect: ReadRect,
    done: (data: Uint8Array) => void,
  ) {
    const { gl } = this;
    const bytes = rect.width * rect.height * 4;
    if (bytes <= 0) return;
    const buffer = this.take(bytes);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.readBuffer(attachment);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer.handle);
    gl.readPixels(rect.x, rect.y, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      this.free.push(buffer);
      return;
    }
    // Make sure the fence reaches the GPU, or it may never signal.
    gl.flush();
    this.pending.push({ sync, buffer, bytes, done });
    while (this.pending.length > MAX_PENDING_READS) this.drop(this.pending.shift()!);
  }

  /** Hand over every finished read, in the order they were requested. Call once per frame. */
  poll() {
    const { gl } = this;
    while (this.pending.length > 0) {
      const read = this.pending[0]!;
      if (gl.getSyncParameter(read.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      this.pending.shift();
      const data = new Uint8Array(read.bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, read.buffer.handle);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      // After the read: Chrome ties its readback shadow copy to the fence.
      gl.deleteSync(read.sync);
      this.free.push(read.buffer);
      read.done(data);
    }
  }

  /**
   * Forget every read and buffer. After a lost context the handles are dead, so pass
   * `lost` to skip deleting them.
   */
  reset(lost = false) {
    if (!lost) {
      for (const read of this.pending) this.drop(read);
      for (const buffer of this.free) this.gl.deleteBuffer(buffer.handle);
    }
    this.pending = [];
    this.free = [];
  }

  private drop(read: Pending) {
    this.gl.deleteSync(read.sync);
    this.free.push(read.buffer);
  }

  /** A free pack buffer of at least `bytes`, grown or created as needed. */
  private take(bytes: number): PackBuffer {
    const { gl } = this;
    const index = this.free.findIndex((b) => b.capacity >= bytes);
    const buffer =
      index >= 0
        ? this.free.splice(index, 1)[0]!
        : (this.free.pop() ?? { handle: gl.createBuffer(), capacity: 0 });
    if (buffer.capacity < bytes) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer.handle);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      buffer.capacity = bytes;
    }
    return buffer;
  }
}

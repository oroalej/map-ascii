import { packedTransferables } from '../agent-frame';
import { frameFromReply, type FrameReply, type FrameResult } from '../worker-api';

/**
 * A worker reply as the main thread receives it: structured-cloned with its packed agent
 * columns transferred (detached here, as in the worker), then decoded.
 */
export function deliver(reply: FrameReply): FrameResult {
  return frameFromReply(structuredClone(reply, { transfer: packedTransferables(reply.packed) }));
}

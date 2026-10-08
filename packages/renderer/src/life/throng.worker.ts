/** Crowd field worker (`throng-pool.ts`): chunk classification and terrain checks. */
import { throngWorker } from './throng-work';
import type { ThrongWorkerRequest, ThrongWorkerResponse } from './throng-protocol';

// The package compiles with the DOM lib, where `self` is a Window; this file runs in a worker.
const scope = self as unknown as {
  postMessage(message: ThrongWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ThrongWorkerRequest>) => void) | null;
};
const handle = throngWorker((message, transfer) => scope.postMessage(message, transfer));
scope.onmessage = ({ data }) => handle(data);

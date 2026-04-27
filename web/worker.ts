/// <reference lib="webworker" />
/**
 * Web Worker entry. Wires the WorkerHost to `self.postMessage` /
 * `self.addEventListener('message', ...)`.
 *
 * The host owns the run loop, message protocol, and machine lifecycle.
 * This file is pure plumbing; keeping it small means the bundle's worker
 * chunk doesn't pull in anything that doesn't run inside the worker.
 *
 * The triple-slash reference above is needed because the project's base
 * tsconfig has `lib: ["ES2022", "DOM"]` for the main thread; this file
 * lives inside the same project but runs in a worker context. The lib
 * pulls in `DedicatedWorkerGlobalScope` and the worker-flavoured
 * `postMessage` overload.
 */

import { WorkerHost } from '../src/browser/worker-host.js';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from '../src/browser/protocol.js';

declare const self: DedicatedWorkerGlobalScope;

const post = (msg: WorkerToMainMessage): void => {
  // Transferable optimisation: TX byte buffers are owned by the worker for
  // exactly one postMessage — handing ownership to main keeps zero-copy.
  if (msg.type === 'tx') {
    self.postMessage(msg, [msg.bytes.buffer]);
    return;
  }
  self.postMessage(msg);
};

const fetchImage = async (url: string): Promise<Uint8Array> => {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Image fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
};

const host = new WorkerHost({ post, fetchImage });

self.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  host.handleMessage(event.data);
});

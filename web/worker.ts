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
  // Same deal for overlay chunks (Phase 17 M1): each chunk's buffer is
  // freshly allocated at sweep time and referenced nowhere else in the
  // worker — transferring dodges a structured-clone copy per chunk.
  if (msg.type === 'overlay-sweep') {
    self.postMessage(msg, msg.chunks.map((c) => c.bytes.buffer));
    return;
  }
  // Captured disk images (Phase 18 M2): fresh sector-loop copies,
  // referenced nowhere else worker-side — an embedded capture would
  // otherwise structured-clone ~32 MB. The machine-state object's many
  // small page buffers stay cloned (M1's capture already copied them;
  // collecting every buffer isn't worth the bookkeeping).
  if (msg.type === 'state-captured') {
    const transfers: ArrayBuffer[] = [];
    if (msg.primary !== undefined && msg.primary.bytes.buffer instanceof ArrayBuffer) {
      transfers.push(msg.primary.bytes.buffer);
    }
    if (msg.secondary != null && msg.secondary.bytes.buffer instanceof ArrayBuffer) {
      transfers.push(msg.secondary.bytes.buffer);
    }
    // Field fix #4: a reference capture's carried epoch — chunk
    // buffers are freshly allocated at sweep time, same as the
    // overlay-sweep case above.
    if (msg.overlayEpoch != null) {
      for (const c of msg.overlayEpoch.chunks) {
        if (c.bytes.buffer instanceof ArrayBuffer) transfers.push(c.bytes.buffer);
      }
    }
    self.postMessage(msg, transfers);
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

// TAN (Phase 14 M3-tabs): every same-origin tab joins one LAN over
// this channel — unique LOCALIP/MAC leased automatically, frames
// trunked between tabs. `telnet 10.0.2.<other-tab>` just works once
// both sides have run `net start ne0`. The literal adapts the DOM
// BroadcastChannel to the substrate's DOM-free FrameChannel shape
// (the onmessage property types are strictly contravariant-hostile;
// a setter bridges them).
const tanChannel = new BroadcastChannel('emu86-tan-v1');
const host = new WorkerHost({
  post,
  fetchImage,
  tan: {
    channel: {
      postMessage: (data: unknown) => tanChannel.postMessage(data),
      set onmessage(handler: ((ev: { data: unknown }) => void) | null) {
        tanChannel.onmessage = handler;
      },
      close: () => tanChannel.close(),
    },
  },
});

self.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  host.handleMessage(event.data);
});

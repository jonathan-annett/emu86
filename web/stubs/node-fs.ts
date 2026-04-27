/**
 * Browser-bundle stub for `node:fs`.
 *
 * Vite aliases `node:fs` → this file when bundling for the browser. The
 * exports throw on call: nothing in the browser path should reach them
 * (we use InMemoryDisk, not NodeFileDisk), but if a future change pulls
 * NodeFileDisk into the bundle the failure surfaces immediately rather
 * than silently zero-filling reads.
 *
 * Signatures match `node:fs` closely enough that TypeScript doesn't pull
 * the real types here — at type-check time the `@types/node` resolution
 * still wins.
 */

function fail(name: string): never {
  throw new Error(`emu86: node:fs.${name} called in browser bundle`);
}

export function closeSync(_fd: number): void { fail('closeSync'); }
export function fstatSync(_fd: number): { size: number } { return fail('fstatSync'); }
export function openSync(_path: string, _flags: string): number { return fail('openSync'); }
export function readSync(
  _fd: number,
  _buffer: Uint8Array,
  _offset: number,
  _length: number,
  _position: number | null,
): number { return fail('readSync'); }
export function writeSync(
  _fd: number,
  _buffer: Uint8Array,
  _offset: number,
  _length: number,
  _position: number | null,
): number { return fail('writeSync'); }

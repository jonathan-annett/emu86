/**
 * Editor-panel file policy (Phase 16 M4) — the pure half, split from
 * editor-panel.ts so tests can import it under Node: the vendored
 * CodeJar reads `window` at module scope, which makes the DOM half
 * browser-only by construction.
 *
 * Policy, per the brief: binary files are skipped by the PANEL (a NUL
 * in the first 512 bytes, or size over the editor cap) — the guest is
 * unaffected, and skips are listed, never hidden. Text crosses the
 * seam as latin1: MINIX v1 stores bytes, ELKS speaks ASCII, latin1
 * round-trips every byte value 0–255 losslessly.
 */

import type { MinixFileSystem } from '../src/disk/minix-fs.js';

/** Files bigger than this are listed as skipped, not opened — a sane
 *  editor cap, far above any source file the guest toolchain handles. */
export const EDITOR_MAX_FILE_BYTES = 256 * 1024;

export interface PanelFile {
  path: string;
  sizeBytes: number;
}

export interface SkippedFile {
  path: string;
  reason: 'binary' | 'too-large' | 'unreadable' | 'special';
}

/** NUL in the first 512 bytes ⇒ not text (brief §1's sniff). */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const n = Math.min(512, bytes.byteLength);
  for (let i = 0; i < n; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Walk the whole tree and split it into editable text files and
 * honestly-listed skips. Depth-first, path-sorted; `.`/`..` ignored.
 */
export function listEditableFiles(fs: MinixFileSystem): {
  files: PanelFile[];
  skipped: SkippedFile[];
} {
  const files: PanelFile[] = [];
  const skipped: SkippedFile[] = [];
  const stack: string[] = ['/'];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const listed = fs.list(dir);
    if (!listed.ok) continue; // list on a walked dir failing = corrupt; skip subtree
    for (const entry of listed.value) {
      if (entry.name === '.' || entry.name === '..') continue;
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.stat.type === 'dir') {
        stack.push(path);
        continue;
      }
      if (entry.stat.type !== 'file') {
        skipped.push({ path, reason: 'special' });
        continue;
      }
      if (entry.stat.sizeBytes > EDITOR_MAX_FILE_BYTES) {
        skipped.push({ path, reason: 'too-large' });
        continue;
      }
      const read = fs.readFile(path);
      if (!read.ok) {
        skipped.push({ path, reason: 'unreadable' });
        continue;
      }
      if (isProbablyBinary(read.value)) {
        skipped.push({ path, reason: 'binary' });
        continue;
      }
      files.push({ path, sizeBytes: entry.stat.sizeBytes });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  skipped.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped };
}

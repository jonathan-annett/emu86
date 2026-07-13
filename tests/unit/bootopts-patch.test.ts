/**
 * Unit tests for the /bootopts serial patch (Phase 14 M2).
 *
 * Synthetic images only — the real-image path is covered by
 * `tests/integration/browser-hd-serial.test.ts`. The synthetic block
 * mirrors the stock `hd32-minix.img` shape verified on 2026-07-13:
 * marker header, commented examples, one active `hma=kernel` line.
 */

import { describe, it, expect } from 'vitest';
import {
  BOOTOPTS_MARKER,
  BOOTOPTS_SIZE,
  SERIAL_CONSOLE_LINE,
  SERIAL_RUNLEVEL_LINE,
  findBootopts,
  hasSerialConsole,
  patchBootoptsForSerial,
} from '../../src/browser/bootopts-patch.js';
import { WorkerHost } from '../../src/browser/worker-host.js';
import type { WorkerToMainMessage } from '../../src/browser/protocol.js';

const HD32_LIKE_BLOCK = [
  '## /bootopts 1023 max',
  '#TZ=MDT6',
  '#ne0=12,0x300,,0x80',
  'hma=kernel',
  '#xms=on',
  '',
].join('\n');

/** Build a synthetic image with a /bootopts block at `offset`. */
function makeImage(blockText: string, offset: number, size = 8192): Uint8Array {
  const image = new Uint8Array(size);
  for (let i = 0; i < blockText.length; i++) {
    image[offset + i] = blockText.charCodeAt(i);
  }
  return image;
}

function blockText(image: Uint8Array, offset: number): string {
  let text = '';
  for (let i = 0; i < BOOTOPTS_SIZE; i++) {
    const byte = image[offset + i] ?? 0;
    if (byte === 0x00) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

describe('bootopts-patch', () => {
  it('finds the marker and rejects images without one', () => {
    expect(findBootopts(makeImage(HD32_LIKE_BLOCK, 2048))).toBe(2048);
    expect(findBootopts(new Uint8Array(4096))).toBeNull();
  });

  it('treats a marker with no room for a full block as absent', () => {
    // Marker placed so the 1024-byte block would run past image end.
    const image = makeImage(HD32_LIKE_BLOCK, 8192 - 100);
    expect(findBootopts(image)).toBeNull();
    expect(patchBootoptsForSerial(image)).toBeNull();
  });

  it('detects an active serial console but not a commented one', () => {
    const serial = makeImage(
      `${BOOTOPTS_MARKER}\n${SERIAL_CONSOLE_LINE}\n`,
      512,
    );
    const commented = makeImage(
      `${BOOTOPTS_MARKER}\n#console=ttyS0,9600\n`,
      512,
    );
    expect(hasSerialConsole(serial)).toBe(true);
    expect(hasSerialConsole(commented)).toBe(false);
    expect(hasSerialConsole(new Uint8Array(4096))).toBe(false);
  });

  it('appends the serial line while preserving existing options', () => {
    const image = makeImage(HD32_LIKE_BLOCK, 1024);
    const patched = patchBootoptsForSerial(image);
    expect(patched).not.toBeNull();
    if (patched === null) return;

    // Same length, original untouched.
    expect(patched.length).toBe(image.length);
    expect(blockText(image, 1024)).toBe(HD32_LIKE_BLOCK);

    const text = blockText(patched, 1024);
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe('## /bootopts 1023 max');
    expect(lines).toContain('hma=kernel');
    expect(lines).toContain('#ne0=12,0x300,,0x80');
    expect(lines[lines.length - 2]).toBe(SERIAL_CONSOLE_LINE);
    expect(lines[lines.length - 1]).toBe(SERIAL_RUNLEVEL_LINE);
    expect(hasSerialConsole(patched)).toBe(true);
  });

  it('drops competing active console=/runlevel lines, keeps commented ones', () => {
    const image = makeImage(
      `${BOOTOPTS_MARKER}\nconsole=tty1\n#console=old\n1\n`,
      512,
    );
    const patched = patchBootoptsForSerial(image);
    expect(patched).not.toBeNull();
    if (patched === null) return;
    const lines = blockText(patched, 512).split('\n');
    expect(lines).not.toContain('console=tty1');
    expect(lines).toContain('#console=old');
    expect(lines).toContain(SERIAL_CONSOLE_LINE);
    // Old runlevel word replaced by ours, exactly once.
    expect(lines.filter((l) => /^[0-9]$/.test(l.trim()))).toEqual([SERIAL_RUNLEVEL_LINE]);
  });

  it('throws when the block has no room for the extra line', () => {
    const full =
      `${BOOTOPTS_MARKER}\n` + 'x'.repeat(BOOTOPTS_SIZE - BOOTOPTS_MARKER.length - 4);
    const image = makeImage(full, 512, 4096);
    expect(() => patchBootoptsForSerial(image)).toThrow(/too full/);
  });
});

describe('WorkerHost serial auto-patch (Phase 14 M2)', () => {
  /**
   * Boot a WorkerHost with a synthetic marker-bearing image forced to
   * hard-disk class via explicit geometry, and confirm the machine's
   * primary disk carries the patched block. Floppy-class images must
   * pass through untouched.
   */
  async function bootAndReadBlock(diskClass: 'floppy' | 'hard-disk'): Promise<string> {
    // Block starts at sector boundary so we can read it back per-sector.
    const image = makeImage(HD32_LIKE_BLOCK, 1024, 64 * 512);
    const posts: WorkerToMainMessage[] = [];
    const host = new WorkerHost({ post: (m) => posts.push(m), autoRun: false });
    host.handleMessage({
      type: 'boot',
      config: {
        imageBytes: image,
        geometry: { cylinders: 1, heads: diskClass === 'hard-disk' ? 16 : 2, sectorsPerTrack: diskClass === 'hard-disk' ? 4 : 32 },
        diskClass,
      },
    });
    await host.whenIdle();
    expect(posts.some((m) => m.type === 'ready')).toBe(true);
    const disk = host.machine?.disk;
    expect(disk).toBeTruthy();
    if (!disk) return '';
    // /bootopts at byte 1024 = LBA 2 (512-byte sectors).
    const sector = disk.readSector(2);
    let text = '';
    for (const byte of sector) {
      if (byte === 0x00) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  it('patches a hard-disk primary lacking a serial console', async () => {
    const text = await bootAndReadBlock('hard-disk');
    expect(text).toContain(SERIAL_CONSOLE_LINE);
    expect(text).toContain('hma=kernel');
  });

  it('leaves floppy primaries untouched', async () => {
    const text = await bootAndReadBlock('floppy');
    expect(text).not.toContain(SERIAL_CONSOLE_LINE);
    expect(text).toContain('hma=kernel');
  });
});

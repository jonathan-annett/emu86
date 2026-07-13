/**
 * NE2000 device unit tests (Phase 14 M3a).
 *
 * Drives the device exactly the way ELKS's ne2k driver does — same
 * register sequences as `reference/elks/elks/arch/i86/drivers/net/
 * ne2k-asm.S` — so passing here means the register-level contract the
 * kernel relies on holds. The full-kernel path is covered by
 * `tests/integration/elks-ne2k.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { NE2000, NE2K_BASE, NE2K_DEFAULT_MAC } from '../../src/devices/ne2000.js';

const B = NE2K_BASE;

interface Harness {
  nic: NE2000;
  frames: Uint8Array[];
  irqs: number;
}

function makeNic(): Harness {
  const frames: Uint8Array[] = [];
  const h: Harness = { nic: null as unknown as NE2000, frames, irqs: 0 };
  h.nic = new NE2000({
    onTransmit: (f) => frames.push(f),
    onIRQ: () => {
      h.irqs++;
    },
  });
  return h;
}

/** The driver's dma_init + CR start, word mode assumed set by caller. */
function remoteStart(nic: NE2000, mode: 'read' | 'write', addr: number, count: number): void {
  nic.writeByte(B + 0x08, addr & 0xff);
  nic.writeByte(B + 0x09, (addr >> 8) & 0xff);
  nic.writeByte(B + 0x0a, count & 0xff);
  nic.writeByte(B + 0x0b, (count >> 8) & 0xff);
  nic.writeByte(B + 0x00, mode === 'read' ? 0x0a : 0x12);
}

/** Bring the ring up the way ne2k_init/rx_init do, then start. */
function startWithRing(nic: NE2000): void {
  nic.writeByte(B + 0x00, 0x21);       // page 0, stop
  nic.writeByte(B + 0x0e, 0x49);       // DCR word mode
  nic.writeByte(B + 0x0c, 0x04);       // RCR: broadcast ok
  nic.writeByte(B + 0x01, 0x46);       // PSTART
  nic.writeByte(B + 0x02, 0x80);       // PSTOP
  nic.writeByte(B + 0x03, 0x46);       // BNRY
  nic.writeByte(B + 0x00, 0x40);       // page 1
  nic.writeByte(B + 0x07, 0x47);       // CURR = BNRY + 1
  nic.writeByte(B + 0x00, 0x22);       // page 0, start
  nic.writeByte(B + 0x0f, 0x1b);       // IMR: OVW|TXE|PTX|PRX (16-bit card mask)
}

describe('NE2000 — ELKS driver contract', () => {
  it('answers the probe: CR write 0x21 reads back 0x21', () => {
    const { nic } = makeNic();
    nic.writeByte(B, 0x21);
    expect(nic.readByte(B)).toBe(0x21);
  });

  it('TXP always reads back 0 (transmits are instantaneous)', () => {
    const { nic } = makeNic();
    nic.writeByte(B, 0x22);
    expect(nic.readByte(B) & 0x04).toBe(0);
  });

  it('serves the PROM as 16-bit words: MAC in low bytes, zero high bytes, 0x57 signature', () => {
    const { nic } = makeNic();
    nic.writeByte(B, 0x21);
    nic.writeByte(B + 0x0e, 0x49); // word mode
    remoteStart(nic, 'read', 0, 32);
    const words: number[] = [];
    for (let i = 0; i < 16; i++) words.push(nic.readWord(B + 0x10));
    for (let i = 0; i < 6; i++) {
      expect(words[i]! & 0xff).toBe(NE2K_DEFAULT_MAC[i]);
      expect(words[i]! >> 8).toBe(0x00); // 16-bit card heuristic (ne2k.c:475)
    }
    expect(words[14]! & 0xff).toBe(0x57);
    expect(words[15]! & 0xff).toBe(0x57);
    // RDC latched once the count exhausted (dma_read spins on it).
    expect(nic.readByte(B + 0x07) & 0x40).toBe(0x40);
  });

  it('remote write → RAM → remote read round-trips', () => {
    const { nic } = makeNic();
    nic.writeByte(B + 0x0e, 0x49);
    const payload = [0xde, 0xad, 0xbe, 0xef];
    remoteStart(nic, 'write', 0x4000, 4);
    nic.writeWord(B + 0x10, 0xadde);
    nic.writeWord(B + 0x10, 0xefbe);
    expect(nic.readByte(B + 0x07) & 0x40).toBe(0x40); // RDC
    nic.writeByte(B + 0x07, 0x40);                     // clear it
    remoteStart(nic, 'read', 0x4000, 4);
    const w0 = nic.readWord(B + 0x10);
    const w1 = nic.readWord(B + 0x10);
    expect([w0 & 0xff, w0 >> 8, w1 & 0xff, w1 >> 8]).toEqual(payload);
  });

  it('transmits RAM[TPSR<<8 .. +TBCR] on CR=0x06 and latches PTX + IRQ', () => {
    const h = makeNic();
    const { nic } = h;
    startWithRing(nic);
    // Stage a frame at page 0x40 the way ne2k_pack_put does.
    const frame = Array.from({ length: 64 }, (_, i) => i & 0xff);
    remoteStart(nic, 'write', 0x4000, 64);
    for (let i = 0; i < 64; i += 2) {
      nic.writeWord(B + 0x10, (frame[i]! | (frame[i + 1]! << 8)) & 0xffff);
    }
    nic.writeByte(B + 0x04, 0x40); // TPSR
    nic.writeByte(B + 0x05, 64);   // TBCR0
    nic.writeByte(B + 0x06, 0);    // TBCR1
    const irqsBefore = h.irqs;
    nic.writeByte(B, 0x06);        // TXP | STA
    expect(h.frames).toHaveLength(1);
    expect(Array.from(h.frames[0]!)).toEqual(frame);
    expect(nic.readByte(B + 0x07) & 0x02).toBe(0x02); // ISR.PTX
    expect(nic.readByte(B + 0x04)).toBe(0x01);        // TSR: clean transmit
    expect(h.irqs).toBe(irqsBefore + 1);
  });

  it('receives into the ring with a QEMU-shaped header and advances CURR', () => {
    const h = makeNic();
    const { nic } = h;
    startWithRing(nic);
    const frame = new Uint8Array(70).map((_, i) => (i * 3) & 0xff);
    const irqsBefore = h.irqs;
    expect(nic.injectFrame(frame)).toBe(true);
    expect(h.irqs).toBe(irqsBefore + 1);
    expect(nic.readByte(B + 0x07) & 0x01).toBe(0x01); // ISR.PRX

    // CURR advanced past one 74-byte (70+4) packet: 0x47 → 0x48.
    nic.writeByte(B, 0x42); // page 1
    expect(nic.readByte(B + 0x07)).toBe(0x48);
    nic.writeByte(B, 0x02); // page 0

    // Read the packet back through remote DMA like ne2k_pack_get.
    remoteStart(nic, 'read', 0x4700, 4 + 70);
    const bytes: number[] = [];
    for (let i = 0; i < 74; i += 2) {
      const w = nic.readWord(B + 0x10);
      bytes.push(w & 0xff, w >> 8);
    }
    expect(bytes[0]).toBe(0x01);          // status
    expect(bytes[1]).toBe(0x48);          // next page
    expect(bytes[2]! | (bytes[3]! << 8)).toBe(74); // total = len + 4
    expect(bytes.slice(4)).toEqual(Array.from(frame));
  });

  it('pads short frames to the 60-byte ethernet minimum', () => {
    const { nic } = makeNic();
    startWithRing(nic);
    expect(nic.injectFrame(new Uint8Array(20).fill(0xaa))).toBe(true);
    remoteStart(nic, 'read', 0x4700, 4);
    const w0 = nic.readWord(B + 0x10);
    const w1 = nic.readWord(B + 0x10);
    expect(w0 & 0xff).toBe(0x01);
    expect(w1).toBe(64); // total = 60 (padded) + 4 (header)
  });

  it('raises OVW and drops the frame when the ring hits BOUNDARY', () => {
    const { nic } = makeNic();
    startWithRing(nic);
    // 252-byte frames occupy exactly one page (252 + 4 = 256). Ring
    // pages 0x47..0x7F with BNRY at 0x46: the 57th packet would leave
    // CURR == BNRY (ring reads as empty ⇒ data loss), so exactly 56
    // are accepted before overflow.
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (nic.injectFrame(new Uint8Array(252))) accepted++;
      else break;
    }
    expect(accepted).toBe(56);
    expect(nic.readByte(B + 0x07) & 0x10).toBe(0x10); // ISR.OVW
  });

  it('remote DMA wraps the ring seam: a PSTOP-straddling packet reads back exactly', () => {
    // The ELKS driver reads each packet in ONE dma_read and trusts the
    // card to wrap at PSTOP (its own seam check is commented out,
    // ne2k-asm.S:492). Regression for the telnet'd-invaders crash:
    // without the wrap, the tail of a seam-straddling packet came back
    // as garbage (client TCP bad checksums, server ktcp read panic).
    const { nic } = makeNic();
    startWithRing(nic);
    // Park the ring so the next packet lands across PSTOP (0x80→0x46):
    // CURR at the last page, BNRY safely mid-ring.
    nic.writeByte(B + 0x03, 0x50); // BNRY
    nic.writeByte(B, 0x42);        // page 1
    nic.writeByte(B + 0x07, 0x7f); // CURR = last ring page
    nic.writeByte(B, 0x02);        // page 0

    const frame = new Uint8Array(300).map((_, i) => (i * 11 + 3) & 0xff);
    expect(nic.injectFrame(frame)).toBe(true);

    // Header at page 0x7F: next page wraps past PSTOP to 0x47.
    remoteStart(nic, 'read', 0x7f00, 4);
    const h0 = nic.readWord(B + 0x10);
    const h1 = nic.readWord(B + 0x10);
    expect(h0 & 0xff).toBe(0x01);       // status
    expect(h0 >> 8).toBe(0x47);         // next page (wrapped)
    expect(h1).toBe(304);               // 300 + 4
    nic.writeByte(B + 0x07, 0x40);      // clear RDC

    // One continuous DMA read across the seam, like ne2k_pack_get.
    remoteStart(nic, 'read', 0x7f04, 300);
    const bytes: number[] = [];
    for (let i = 0; i < 300; i += 2) {
      const w = nic.readWord(B + 0x10);
      bytes.push(w & 0xff, w >> 8);
    }
    expect(bytes).toEqual(Array.from(frame));
  });

  it('drops frames when stopped or in monitor mode', () => {
    const { nic } = makeNic();
    expect(nic.injectFrame(new Uint8Array(64))).toBe(false); // stopped
    startWithRing(nic);
    nic.writeByte(B + 0x0c, 0x20); // RCR monitor (PROM-read window)
    expect(nic.injectFrame(new Uint8Array(64))).toBe(false);
  });

  it('latches ISR.RST on reset-port read and on STOP; STA clears it', () => {
    const { nic } = makeNic();
    nic.writeByte(B, 0x22); // start
    expect(nic.readByte(B + 0x07) & 0x80).toBe(0);
    nic.readByte(B + 0x1f); // reset pulse
    expect(nic.readByte(B + 0x07) & 0x80).toBe(0x80);
    nic.writeByte(B, 0x22); // STA clears RST
    expect(nic.readByte(B + 0x07) & 0x80).toBe(0);
    nic.writeByte(B, 0x21); // STOP sets it again (ne2k_clr_oflow waits on this)
    expect(nic.readByte(B + 0x07) & 0x80).toBe(0x80);
  });

  it('ISR is write-1-to-clear and gates the IRQ edge through IMR', () => {
    const h = makeNic();
    const { nic } = h;
    startWithRing(nic);
    nic.injectFrame(new Uint8Array(64));
    expect(h.irqs).toBe(1);
    // Second event while the line is high: no second edge.
    nic.injectFrame(new Uint8Array(64));
    expect(h.irqs).toBe(1);
    // Clear both PRX events; line drops; next event is a fresh edge.
    nic.writeByte(B + 0x07, 0x7f);
    expect(nic.readByte(B + 0x07) & 0x7f).toBe(0);
    nic.injectFrame(new Uint8Array(64));
    expect(h.irqs).toBe(2);
  });

  it('masked interrupts do not fire the IRQ callback', () => {
    const h = makeNic();
    const { nic } = h;
    startWithRing(nic);
    nic.writeByte(B + 0x0f, 0x00); // IMR: everything masked
    nic.injectFrame(new Uint8Array(64));
    expect(h.irqs).toBe(0);
    expect(nic.readByte(B + 0x07) & 0x01).toBe(0x01); // still latched in ISR
  });
});

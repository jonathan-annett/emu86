/**
 * Minimal ZIP writer (tab-shark export — TAN-freeze brief §7).
 *
 * STORE only (no compression): the export's contents are either
 * already-small JSON/text or raw binary a debugger wants byte-exact;
 * a dependency-free container matters more than ratio (hard rule 2 —
 * and the ZIP container itself is just headers + CRC-32, ~90 lines).
 *
 * Format per APPNOTE.TXT: local file header (PK\3\4) + data per
 * entry, then the central directory (PK\1\2 records + PK\5\6 end).
 * Names are stored as UTF-8 with the language-encoding flag set.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  name: string;
  bytes: Uint8Array;
}

/** CRC-32 (IEEE 802.3), table-driven — the ZIP checksum. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (ZIP's timestamp format), from a Date. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((Math.max(0, d.getFullYear() - 1980) & 0x7f) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  };
}

/** Build a STORE-only .zip from the entries, stamped `at`. */
export function buildZip(entries: readonly ZipEntry[], at: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(at);

  interface Placed {
    nameBytes: Uint8Array;
    crc: number;
    size: number;
    offset: number;
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const placed: Placed[] = [];

  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number): number[] => [
    v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff,
  ];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    placed.push({ nameBytes, crc, size: entry.bytes.length, offset });
    push(
      new Uint8Array([
        0x50, 0x4b, 0x03, 0x04, // PK\3\4
        ...u16(20),             // version needed: 2.0
        ...u16(0x0800),         // flags: UTF-8 names
        ...u16(0),              // method: STORE
        ...u16(time), ...u16(date),
        ...u32(crc),
        ...u32(entry.bytes.length), // compressed = uncompressed (STORE)
        ...u32(entry.bytes.length),
        ...u16(nameBytes.length),
        ...u16(0),              // no extra field
      ]),
    );
    push(nameBytes);
    push(entry.bytes);
  }

  const dirStart = offset;
  for (const p of placed) {
    push(
      new Uint8Array([
        0x50, 0x4b, 0x01, 0x02, // PK\1\2
        ...u16(20), ...u16(20), // made-by / needed
        ...u16(0x0800),
        ...u16(0),
        ...u16(time), ...u16(date),
        ...u32(p.crc),
        ...u32(p.size), ...u32(p.size),
        ...u16(p.nameBytes.length),
        ...u16(0), ...u16(0),   // extra, comment
        ...u16(0),              // disk number
        ...u16(0),              // internal attrs
        ...u32(0),              // external attrs
        ...u32(p.offset),
      ]),
    );
    push(p.nameBytes);
  }
  const dirSize = offset - dirStart;
  push(
    new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, // PK\5\6
      ...u16(0), ...u16(0),
      ...u16(placed.length), ...u16(placed.length),
      ...u32(dirSize),
      ...u32(dirStart),
      ...u16(0), // no comment
    ]),
  );

  const out = new Uint8Array(offset);
  let at2 = 0;
  for (const c of chunks) {
    out.set(c, at2);
    at2 += c.length;
  }
  return out;
}

/**
 * BIOS ROM image generator.
 *
 * Produces a 64 KiB `Uint8Array` representing the system BIOS ROM that
 * lives at segment 0xF000 (linear 0xF0000-0xFFFFF). The image contains:
 *
 *   1. The reset vector at 0xFFFF0 — a far jump into the BIOS init code.
 *   2. The BIOS init code at F000:0100 — sets up the IVT, the BDA, and
 *      finally invokes INT 19h to boot. This is real 8086 machine code
 *      executed by our CPU; no JS magic.
 *   3. A trap stub table at F000:1000..F000:10FF — one byte (0xCF = IRET)
 *      per IVT entry. The IVT (set up at runtime by the init code above)
 *      points each interrupt vector at the corresponding stub. JS handlers
 *      registered at the linear address of each stub run *before* the IRET
 *      executes; they do the actual BIOS work, then the IRET pops back to
 *      the caller. This is the trap-registry mechanism from Phase 1.
 *   4. The diskette parameter table at F000:2000 — a 11-byte block the
 *      init code wires into IVT[0x1E]. Operating systems read it to
 *      discover floppy timing parameters.
 *
 * The init code is hand-encoded 8086 machine code. It is intentionally
 * tiny (~111 bytes) and commented byte-by-byte below. The brief warns
 * against growing it past ~200 bytes — anything past trivial init belongs
 * in JS handlers, not in ROM bytes.
 *
 * Why hand-encoded: there's no other 8086 assembler in this project, and
 * adding one for ~111 bytes that we touch once would be more code than the
 * thing it replaces. If a future brief needs more ROM code we can revisit.
 */

import { BDA } from './bios-data-area.js';

/** Linear base of the system BIOS region (start of the F000 segment). */
export const BIOS_ROM_BASE = 0xF0000;
/** ROM is exactly one 64 KiB segment. */
export const BIOS_ROM_SIZE = 0x10000;
/** Offset within ROM of the BIOS init entry point — `F000:0100`. */
export const BIOS_INIT_OFFSET = 0x0100;
/** Offset within ROM of the trap stub table base — `F000:1000`. */
export const BIOS_TRAP_TABLE_OFFSET = 0x1000;
/** Offset within ROM of the diskette parameter table — `F000:2000`. */
export const BIOS_DISKETTE_PARAM_TABLE_OFFSET = 0x2000;
/**
 * Offset within ROM of the reset-vector far jump. Must be at offset 0xFFF0
 * so that linear address `(0xFFFF << 4) + 0x0000` lands on the JMP byte —
 * `0xF0000 + 0xFFF0 = 0xFFFF0`.
 */
export const BIOS_RESET_VECTOR_OFFSET = 0xFFF0;

/**
 * The linear address of the trap stub for INT N is
 * `BIOS_ROM_BASE + BIOS_TRAP_TABLE_OFFSET + N`. Each stub is exactly one
 * byte (0xCF = IRET). 256 stubs occupy 256 contiguous bytes.
 */
export function trapAddressForVector(vector: number): number {
  if (!Number.isInteger(vector) || vector < 0 || vector > 0xFF) {
    throw new Error(`trapAddressForVector: vector must be 0..255 (got ${vector})`);
  }
  return BIOS_ROM_BASE + BIOS_TRAP_TABLE_OFFSET + vector;
}

/**
 * Layout description returned alongside the bytes. Lets the Machine register
 * trap handlers without having to know our offset conventions.
 */
export interface BiosRomLayout {
  /** Linear address of every trap stub, keyed by INT vector (0..255). */
  trapAddresses: Readonly<Record<number, number>>;
  /** Linear address of the reset-vector far jump (0xFFFF0). */
  resetVector: number;
  /** Linear address of the BIOS init entry point (0xF0100). */
  initEntry: number;
  /** Linear address of the diskette parameter table (0xF2000). */
  disketteParamTable: number;
  /** Length in bytes of the hand-encoded init code (for tests / sanity). */
  initCodeLength: number;
}

export interface BuiltBiosRom {
  /** 64 KiB ROM image, ready for `memory.loadROM(baseLinear, bytes)`. */
  bytes: Uint8Array;
  /** Linear base address (0xF0000). */
  baseLinear: number;
  /** Layout details for handler registration. */
  layout: BiosRomLayout;
}

/**
 * Build the BIOS ROM image. Pure function — no I/O, no clock, no randomness;
 * the same bytes come out every call. The Machine constructs this at startup
 * and hands it to `memory.loadROM`.
 */
export function buildBiosRom(): BuiltBiosRom {
  // ROM convention: unused ROM is 0xFF (open-bus / blank EPROM pattern).
  const bytes = new Uint8Array(BIOS_ROM_SIZE).fill(0xFF);

  // ----- Trap stub table: one IRET (0xCF) per IVT entry -----
  // 256 single-byte stubs starting at offset 0x1000. The init code below
  // populates the IVT to point each vector at its stub.
  const trapAddresses: Record<number, number> = {};
  for (let n = 0; n < 256; n++) {
    bytes[BIOS_TRAP_TABLE_OFFSET + n] = 0xCF;     // IRET
    trapAddresses[n] = BIOS_ROM_BASE + BIOS_TRAP_TABLE_OFFSET + n;
  }

  // ----- BIOS init code at offset 0x0100 -----
  //
  // This is real 8086 machine code that the CPU executes after the reset
  // vector jumps here. It does three things:
  //   1. Build the IVT in low memory: 256 entries × 4 bytes, each pointing
  //      at the corresponding trap stub `F000:1000+N`.
  //   2. Override IVT[0x1E] to point at the diskette parameter table at
  //      F000:2000 (since INT 1Eh is a data table, not a callable service).
  //   3. Initialise the key BDA fields at segment 0x40.
  //   4. Set up a small stack and `INT 19h` to boot.
  //
  // Each byte is annotated with the assembly source. If you change a byte
  // here, recheck the LOOP relative offset and the total length.
  const initCode: number[] = [
    // --- IVT setup loop ---
    0xFA,                               // CLI
    0x31, 0xC0,                         // XOR AX, AX
    0x8E, 0xD8,                         // MOV DS, AX        ; DS=0 (IVT segment)
    0x8E, 0xC0,                         // MOV ES, AX        ; ES=0
    0x31, 0xFF,                         // XOR DI, DI        ; DI=0 (IVT cursor)
    0xBB, 0x00, 0x10,                   // MOV BX, 0x1000    ; trap-stub offset
    0xBA, 0x00, 0xF0,                   // MOV DX, 0xF000    ; trap-stub segment
    0xB9, 0x00, 0x01,                   // MOV CX, 0x0100    ; 256 iterations
    // vec_loop  (offset 0x112 from BIOS_INIT_OFFSET start = +0x12)
    0x89, 0x1D,                         // MOV [DI], BX      ; offset
    0x89, 0x55, 0x02,                   // MOV [DI+2], DX    ; segment
    0x43,                               // INC BX            ; next stub addr
    0x83, 0xC7, 0x04,                   // ADD DI, 4         ; next IVT entry
    0xE2, 0xF5,                         // LOOP vec_loop     ; rel8 = -11 = 0xF5

    // --- IVT[0x1E] override: diskette parameter table at F000:2000 ---
    0xC7, 0x06, 0x78, 0x00, 0x00, 0x20, // MOV WORD [0x78], 0x2000  ; 0x1E*4 = 0x78
    0xC7, 0x06, 0x7A, 0x00, 0x00, 0xF0, // MOV WORD [0x7A], 0xF000

    // --- BDA setup. DS = 0x40 ---
    0xB8, 0x40, 0x00,                   // MOV AX, 0x0040
    0x8E, 0xD8,                         // MOV DS, AX
    0xC7, 0x06, BDA.EQUIPMENT, 0x00, 0x21, 0x00,        // MOV WORD [0x10], 0x0021   ; equip word
    0xC7, 0x06, BDA.MEMORY_SIZE_KB, 0x00, 0x80, 0x02,   // MOV WORD [0x13], 0x0280   ; 640 KiB
    0xC7, 0x06, BDA.KBBUF_HEAD, 0x00, 0x1E, 0x00,       // MOV WORD [0x1A], 0x001E   ; kb head
    0xC7, 0x06, BDA.KBBUF_TAIL, 0x00, 0x1E, 0x00,       // MOV WORD [0x1C], 0x001E   ; kb tail
    0xC7, 0x06, BDA.KBBUF_START_PTR, 0x00, 0x1E, 0x00,  // MOV WORD [0x80], 0x001E   ; kb start ptr
    0xC7, 0x06, BDA.KBBUF_END_PTR, 0x00, 0x3E, 0x00,    // MOV WORD [0x82], 0x003E   ; kb end ptr
    0xC6, 0x06, BDA.VIDEO_MODE, 0x00, 0x03,             // MOV BYTE [0x49], 0x03     ; mode 3
    0xC7, 0x06, BDA.VIDEO_COLS, 0x00, 0x50, 0x00,       // MOV WORD [0x4A], 0x0050   ; 80 cols
    0xC6, 0x06, BDA.VIDEO_ROWS_MINUS_1, 0x00, 0x18,     // MOV BYTE [0x84], 0x18     ; 24 (rows-1)

    // --- 8259 PIC init (master). Real PC BIOS programs the PIC during POST
    // so that IRQ 0..7 are remapped from the chip's default vector base of 0
    // to vector 0x08..0x0F (and the slave to 0x70..0x77). ELKS, like every
    // other PC kernel, assumes this remap has already happened — without it
    // IRQ 0 lands on INT 0 (divide-error vector) and the kernel's _irqit
    // dispatcher misclassifies it as a trap and skips PIC EOI, which leaves
    // the PIC's ISR stuck and blocks all further IRQs. (Phase 5 diagnosis.)
    //
    // We program the master only — there is no slave PIC device wired in this
    // emulator yet, so the cascade ICW3 byte is harmless. Standard sequence:
    //   ICW1 = 0x11  (ICW4 needed, cascade, edge-triggered)
    //   ICW2 = 0x08  (vector base = 0x08)
    //   ICW3 = 0x04  (slave on IRQ 2 — informational; no slave to route to)
    //   ICW4 = 0x01  (8086 mode, normal EOI)
    //   IMR  = 0xFF  (mask everything; OS will unmask what it wants)
    0xB0, 0x11,                         // MOV AL, 0x11      ; ICW1
    0xE6, 0x20,                         // OUT 0x20, AL      ; PIC1 cmd
    0xB0, 0x08,                         // MOV AL, 0x08      ; ICW2 vec base
    0xE6, 0x21,                         // OUT 0x21, AL      ; PIC1 data
    0xB0, 0x04,                         // MOV AL, 0x04      ; ICW3 cascade
    0xE6, 0x21,                         // OUT 0x21, AL
    0xB0, 0x01,                         // MOV AL, 0x01      ; ICW4 8086 mode
    0xE6, 0x21,                         // OUT 0x21, AL
    0xB0, 0xFF,                         // MOV AL, 0xFF      ; mask all
    0xE6, 0x21,                         // OUT 0x21, AL

    // --- Stack: SS=0, SP=0x7C00 (boot sector loads at 0:7C00, stack grows down) ---
    0x31, 0xC0,                         // XOR AX, AX
    0x8E, 0xD0,                         // MOV SS, AX
    0xBC, 0x00, 0x7C,                   // MOV SP, 0x7C00

    // --- Boot ---
    0xFB,                               // STI
    0xCD, 0x19,                         // INT 19h           ; bootstrap loader

    // --- Should never return; spin-halt as a safety net ---
    0xF4,                               // HLT
    0xEB, 0xFD,                         // JMP $-1
  ];

  for (let i = 0; i < initCode.length; i++) {
    bytes[BIOS_INIT_OFFSET + i] = initCode[i]!;
  }

  // ----- Diskette parameter table at offset 0x2000 -----
  // 11-byte block matching a typical 1.44 MB 3.5" floppy. Pulled from the
  // common XT/AT BIOS values; ELKS / DOS read these but rarely care about
  // the exact contents in our virtual environment.
  const disketteParams: number[] = [
    0xDF,   // Specify byte 1: head-unload time, step-rate
    0x02,   // Specify byte 2: head-load time, DMA mode
    0x25,   // Motor wait time (in clock ticks)
    0x02,   // Bytes-per-sector code (2 = 512 bytes)
    0x12,   // Sectors per track (18 = 1.44 MB)
    0x1B,   // Gap length for read/write
    0xFF,   // Data length (max for 512-byte sectors)
    0x6C,   // Gap length for format
    0xF6,   // Format fill byte
    0x0F,   // Head settle time (ms)
    0x08,   // Motor start time (1/8 second units)
  ];
  for (let i = 0; i < disketteParams.length; i++) {
    bytes[BIOS_DISKETTE_PARAM_TABLE_OFFSET + i] = disketteParams[i]!;
  }

  // ----- Reset vector at 0xFFFF0 (= ROM offset 0xFFF0): far jump to F000:0100 -----
  // EA off_lo off_hi seg_lo seg_hi  =  JMP F000:0100
  bytes[BIOS_RESET_VECTOR_OFFSET + 0] = 0xEA;
  bytes[BIOS_RESET_VECTOR_OFFSET + 1] = BIOS_INIT_OFFSET & 0xFF;
  bytes[BIOS_RESET_VECTOR_OFFSET + 2] = (BIOS_INIT_OFFSET >> 8) & 0xFF;
  bytes[BIOS_RESET_VECTOR_OFFSET + 3] = 0x00;     // segment lo
  bytes[BIOS_RESET_VECTOR_OFFSET + 4] = 0xF0;     // segment hi → 0xF000

  return {
    bytes,
    baseLinear: BIOS_ROM_BASE,
    layout: {
      trapAddresses,
      resetVector: BIOS_ROM_BASE + BIOS_RESET_VECTOR_OFFSET,
      initEntry: BIOS_ROM_BASE + BIOS_INIT_OFFSET,
      disketteParamTable: BIOS_ROM_BASE + BIOS_DISKETTE_PARAM_TABLE_OFFSET,
      initCodeLength: initCode.length,
    },
  };
}

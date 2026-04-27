// Core types and components
export * from './core/types.js';
export { FLAG, Flags } from './core/flags.js';
export { R16, R8, SREG, Registers } from './core/registers.js';
export type { RegisterSnapshot } from './core/registers.js';
export { NullIOBus } from './core/io.js';
export type { IOBus, PortHandler, PortRange } from './core/io.js';

// Real IOBus + future devices live in their own modules
export * from './io/index.js';
export * from './devices/index.js';

// Memory subsystem
export * from './memory/index.js';

// CPU core
export * from './cpu8086/index.js';

// Interrupt delivery substrate
export * from './interrupts/index.js';

// Virtual-time clock
export * from './timing/index.js';

// Runtime (async run loop)
export * from './runtime/index.js';

// Machine compositions (CPU + devices wired into a coherent system)
export * from './machine/index.js';

// Console / Disk abstractions (Phase 1 BIOS infrastructure — interfaces and
// host-side implementations; the actual BIOS handlers live in a later brief).
export * from './console/index.js';
export * from './disk/index.js';

// Host-side wall clock (used by INT 1Ah; deterministic in-memory variant for tests).
export * from './host-clock/index.js';

// Phase 2 BIOS — ROM image generator, BDA helpers, and INT service handlers.
export * from './bios/index.js';

// Phase 3 diagnostics — Tracer + per-step trace runner for ELKS-boot triage.
export * from './diagnostics/index.js';

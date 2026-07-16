/**
 * Whole-machine state capture/restore — Phase 18 M1.
 *
 * Composes the per-component serialize/restore pairs into one
 * {@link MachineState}. This is the state layer ONLY: no protocol, no
 * UI, no IDB (those are M2), and no disk bytes (what restore feeds the
 * primary disk is decision D2's call — the brief's two-phase disk truth
 * lives at the capture-protocol layer, not here). A snapshot is
 * consistent only with its disks; the caller owns that pairing.
 *
 * Capture is legal at any message/step boundary — worker messages land
 * between run turns, never mid-`step()`, so the machine is coherent
 * whenever this runs (brief §1.1: "coherence is free; capture is a
 * message").
 *
 * Restore order is the brief's §1.1 law — reset as the clean baseline,
 * then overwrite: RAM first (in the browser this must happen before the
 * CGA mirror wraps memory.writeByte; here the ordering is kept
 * identical so both paths exercise one sequence), then devices in the
 * machine's reset order, then the clock (silently — advancing would
 * re-tick the PIT), CPU registers LAST. Reset-then-overwrite, never
 * reset-after-restore.
 *
 * Device restores never fire their IRQ/transmit callbacks: every edge
 * that fired before capture is already reflected in the captured
 * PIC/controller state, and re-firing would double-deliver it.
 *
 * ROM pages and the trap registry are NOT carried — both are rebuilt
 * deterministically by machine construction (`buildBiosRom()`); the
 * restore target must be constructed with an equivalent config. M2's
 * fingerprint discipline is what enforces "equivalent"; this layer
 * fails loud only on the mismatches it can see (schema versions, page
 * size, RAM-vs-ROM collisions, RTC presence).
 */

import type { CPUSnapshot } from '../cpu8086/cpu.js';
import type { InterruptControllerState } from '../interrupts/controller.js';
import type { PagedMemoryState } from '../memory/paged-memory.js';
import type {
  KeyboardController8042State,
  Ne2000State,
  Pic8259State,
  Pit8254State,
  Uart16550State,
} from '../devices/index.js';
import type { Rtc146818State } from '../devices/rtc.js';
import type { IBMPCMachine } from './ibm-pc.js';

/** Serialized whole-machine state. Structured-cloneable (Uint8Array-safe). */
export interface MachineState {
  readonly v: 1;
  readonly ram: PagedMemoryState;
  readonly cpu: CPUSnapshot;
  readonly intCtrl: InterruptControllerState;
  readonly pic: Pic8259State;
  readonly pit: Pit8254State;
  /** null when the machine was built without a BIOS (no hostClock). */
  readonly rtc: Rtc146818State | null;
  readonly kbc: KeyboardController8042State;
  readonly uart: Uart16550State;
  readonly nic: Ne2000State;
  /** Virtual-time cycle counter. */
  readonly clockCycles: number;
}

/** Capture the running machine's complete state. Synchronous, no side effects. */
export function captureMachineState(machine: IBMPCMachine): MachineState {
  return {
    v: 1,
    ram: machine.memory.serializeState(),
    cpu: machine.cpu.snapshot(),
    intCtrl: machine.controller.serializeState(),
    pic: machine.pic.serializeState(),
    pit: machine.pit.serializeState(),
    rtc: machine.rtc !== null ? machine.rtc.serializeState() : null,
    kbc: machine.keyboardController.serializeState(),
    uart: machine.uart.serializeState(),
    nic: machine.nic.serializeState(),
    clockCycles: machine.clock.now(),
  };
}

/**
 * Overwrite `machine` with a captured state. The machine must have been
 * constructed with an equivalent config (same memory size, same BIOS
 * posture) — see the module doc for what "equivalent" means and who
 * enforces it.
 */
export function restoreMachineState(machine: IBMPCMachine, state: MachineState): void {
  if (state.v !== 1) {
    throw new Error(`restoreMachineState: unsupported schema version ${String(state.v)}`);
  }
  if ((state.rtc === null) !== (machine.rtc === null)) {
    throw new Error(
      state.rtc !== null
        ? 'restoreMachineState: snapshot carries RTC state but this machine has no RTC'
        : 'restoreMachineState: this machine has an RTC but the snapshot carries none',
    );
  }

  // Reset AS the clean baseline (memory contents survive reset by design;
  // restoreState below replaces them wholesale).
  machine.reset();

  // RAM first.
  machine.memory.restoreState(state.ram);

  // Devices, in the machine's reset order (ibm-pc.ts reset(): controller,
  // pic, pit, rtc, kbc, uart) plus the NIC — which machine.reset() does
  // not touch (pre-existing behaviour, surfaced in the M1 report); its
  // restore is unconditional here, appended after the reset-order six.
  machine.controller.restoreState(state.intCtrl);
  machine.pic.restoreState(state.pic);
  machine.pit.restoreState(state.pit);
  if (state.rtc !== null) machine.rtc!.restoreState(state.rtc);
  machine.keyboardController.restoreState(state.kbc);
  machine.uart.restoreState(state.uart);
  machine.nic.restoreState(state.nic);

  // Clock: silent — stalled wall time must not become guest time, and a
  // notifying advance would re-tick the PIT across the whole restored span.
  machine.clock.restoreCycles(state.clockCycles);

  // CPU registers LAST.
  machine.cpu.restore(state.cpu);
}

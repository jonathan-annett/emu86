export {
  Tracer,
  type TracerOptions,
  type TraceEvent,
  type TraceEventKind,
  type InstructionEvent,
  type IntEvent,
  type TrapEvent,
  type IoEvent,
  type MemWriteEvent,
  type InterruptServiceEvent,
  type MemRange,
} from './tracer.js';
export { instrumentMachine, type InstrumentOptions } from './instrument.js';
export {
  traceRun,
  formatEvent,
  type TraceRunOptions,
  type TraceRunResult,
} from './trace-runner.js';
export {
  installCGAMirror,
  CapturingCGASink,
  OneShotPrefixSink,
  CLEAR_AND_HOME,
  CGA_TEXT_BASE,
  CGA_TEXT_END,
  CGA_TEXT_COLS,
  type CGAMirrorSink,
  type InstallCGAMirrorOptions,
} from './cga-mirror.js';

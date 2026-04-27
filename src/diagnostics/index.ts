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

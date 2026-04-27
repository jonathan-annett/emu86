import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { InMemoryConsole, NodeConsole, type NodeStdinLike } from '../../src/console/index.js';

describe('InMemoryConsole', () => {
  it('writeChar appends to the output buffer', () => {
    const c = new InMemoryConsole();
    c.writeChar(0x48);   // 'H'
    c.writeChar(0x69);   // 'i'
    expect(c.output).toBe('Hi');
    expect(c.outputBytes).toEqual([0x48, 0x69]);
  });

  it('writes are recorded in order, including non-printables', () => {
    const c = new InMemoryConsole();
    [0x07, 0x0A, 0x41].forEach((b) => c.writeChar(b));   // BEL, LF, 'A'
    expect(c.outputBytes).toEqual([0x07, 0x0A, 0x41]);
  });

  it('hasInput is initially false; readChar returns -1', () => {
    const c = new InMemoryConsole();
    expect(c.hasInput()).toBe(false);
    expect(c.readChar()).toBe(-1);
  });

  it('pushInput(string) queues each code, readChar drains in order', () => {
    const c = new InMemoryConsole();
    c.pushInput('ab');
    expect(c.hasInput()).toBe(true);
    expect(c.readChar()).toBe(0x61);
    expect(c.readChar()).toBe(0x62);
    expect(c.hasInput()).toBe(false);
    expect(c.readChar()).toBe(-1);
  });

  it('pushInput(number[]) queues raw byte values', () => {
    const c = new InMemoryConsole();
    c.pushInput([0x00, 0xFF, 0x7F]);
    expect(c.readChar()).toBe(0x00);
    expect(c.readChar()).toBe(0xFF);
    expect(c.readChar()).toBe(0x7F);
    expect(c.readChar()).toBe(-1);
  });

  it('clearOutput / clearInput reset the buffers', () => {
    const c = new InMemoryConsole();
    c.writeChar(0x41);
    c.pushInput('x');
    c.clearOutput();
    c.clearInput();
    expect(c.output).toBe('');
    expect(c.hasInput()).toBe(false);
  });

  it('writeChar masks to 8 bits', () => {
    const c = new InMemoryConsole();
    c.writeChar(0x141);   // == 0x41 & 0xFF
    expect(c.outputBytes).toEqual([0x41]);
  });
});

describe('NodeConsole', () => {
  // We don't touch the real process.stdin/stdout — instead we hand in a fake
  // EventEmitter-backed stdin and a write-capturing stdout. This keeps the
  // tests deterministic, parallel-safe, and compatible with CI environments
  // where stdin is not a TTY.

  function makeFakeStdin(opts: { isTTY?: boolean } = {}): NodeStdinLike & EventEmitter & {
    rawModeCalls: boolean[];
    resumeCount: number;
    emitData(bytes: number[] | Buffer | Uint8Array): void;
  } {
    const ee = new EventEmitter();
    const fake = ee as unknown as NodeStdinLike & EventEmitter & {
      rawModeCalls: boolean[];
      resumeCount: number;
      emitData(bytes: number[] | Buffer | Uint8Array): void;
    };
    fake.isTTY = opts.isTTY ?? false;
    fake.rawModeCalls = [];
    fake.setRawMode = (v: boolean) => { fake.rawModeCalls.push(v); return fake; };
    fake.resumeCount = 0;
    fake.resume = () => { fake.resumeCount++; return fake; };
    fake.emitData = (bytes) => {
      const buf = Array.isArray(bytes) ? Uint8Array.from(bytes) : bytes;
      ee.emit('data', buf);
    };
    return fake;
  }

  function makeFakeStdout() {
    const writes: string[] = [];
    return {
      writes,
      write(chunk: string) { writes.push(chunk); return true; },
    };
  }

  it('writeChar forwards a one-character string to stdout', () => {
    const stdout = makeFakeStdout();
    const stdin = makeFakeStdin();
    const c = new NodeConsole({ stdout, stdin, installExitHook: false });
    c.writeChar(0x48);
    c.writeChar(0x69);
    expect(stdout.writes).toEqual(['H', 'i']);
    c.close();
  });

  it('queues bytes from stdin "data" events and serves them via readChar', () => {
    const stdout = makeFakeStdout();
    const stdin = makeFakeStdin({ isTTY: false });   // piped-input shape
    const c = new NodeConsole({ stdout, stdin, installExitHook: false });
    expect(c.hasInput()).toBe(false);
    stdin.emitData([0x61, 0x62, 0x63]);
    expect(c.hasInput()).toBe(true);
    expect(c.readChar()).toBe(0x61);
    expect(c.readChar()).toBe(0x62);
    expect(c.readChar()).toBe(0x63);
    expect(c.readChar()).toBe(-1);
    c.close();
  });

  it('does not enable raw mode when stdin is not a TTY (piped input)', () => {
    const stdin = makeFakeStdin({ isTTY: false });
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    expect(stdin.rawModeCalls).toEqual([]);
    c.close();
    expect(stdin.rawModeCalls).toEqual([]);
  });

  it('enables raw mode at construction and restores it at close when stdin is a TTY', () => {
    const stdin = makeFakeStdin({ isTTY: true });
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    expect(stdin.rawModeCalls).toEqual([true]);
    c.close();
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });

  it('close is idempotent — second call is a no-op', () => {
    const stdin = makeFakeStdin({ isTTY: true });
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    c.close();
    c.close();
    expect(stdin.rawModeCalls).toEqual([true, false]);   // not [true, false, false]
  });

  it('delivers Ctrl-C (0x03) as a character rather than raising SIGINT', () => {
    const stdin = makeFakeStdin({ isTTY: true });
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    stdin.emitData([0x03]);
    expect(c.readChar()).toBe(0x03);
    c.close();
  });

  it('handles a Buffer chunk', () => {
    const stdin = makeFakeStdin();
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    stdin.emitData(Buffer.from([0x10, 0x20, 0x30]));
    expect(c.readChar()).toBe(0x10);
    expect(c.readChar()).toBe(0x20);
    expect(c.readChar()).toBe(0x30);
    c.close();
  });

  it('calls resume() on stdin so paused streams begin flowing', () => {
    const stdin = makeFakeStdin();
    const c = new NodeConsole({ stdout: makeFakeStdout(), stdin, installExitHook: false });
    expect(stdin.resumeCount).toBe(1);
    c.close();
  });
});

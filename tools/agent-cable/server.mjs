/**
 * The agent cable — localhost server (agent-cable brief M1).
 *
 * Browsers running emu86 dial in over a websocket (`/cable`) and
 * stream their serial consoles; the agent reads and types through a
 * curl-friendly HTTP surface on the same port. Loopback only, zero
 * dependencies: the websocket handshake is SHA-1 + base64 from
 * node:crypto, the framing is done by hand below (the repo's
 * zip-writer precedent — a well-specified format beats a package).
 *
 *   node tools/agent-cable/server.mjs [--port 8737]
 *
 * HTTP surface (all 127.0.0.1):
 *   GET  /machines                     → JSON list of connected machines
 *   GET  /console?from=<id>&since=<n>  → console bytes from offset n
 *        (X-Console-Offset header carries the next offset to poll)
 *   POST /rx?to=<id>                   → request body typed into the machine
 *   POST /spawn?to=<id>&kind=tab|rack  → ask that machine's page to open
 *        a new blank PC (tab = window.open, may need popups allowed;
 *        rack = the embedding rack adds a PC — embedded pages only)
 *
 * Websocket protocol (browser → server, JSON text frames):
 *   {cable:'hello', name, octet, pc, build}   once, identity
 *   {cable:'tx', data:<base64>}               console output chunk
 * (server → browser):
 *   {cable:'rx', data:<base64>}               keystrokes to inject
 *   {cable:'spawn', kind:'tab'|'rack'}        open a new blank PC
 *
 * Exported as a factory so tests can run instances on ephemeral
 * ports; the CLI block at the bottom only fires when run directly.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONSOLE_BUFFER_CAP = 256 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// ---- websocket framing ------------------------------------------------

/** Incremental parser for client (masked) websocket frames. */
export class FrameParser {
  constructor() {
    /** @type {Buffer} */
    this.pending = Buffer.alloc(0);
  }

  /** Feed bytes; returns an array of {opcode, payload} frames. */
  feed(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames = [];
    for (;;) {
      const frame = this.#tryParse();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  #tryParse() {
    const buf = this.pending;
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame too large');
      len = Number(big);
      off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return null;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const un = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3];
      payload = un;
    }
    this.pending = buf.subarray(off + maskLen + len);
    return { opcode, payload };
  }
}

/** Build a server (unmasked) frame. */
export function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// ---- the cable server -------------------------------------------------

/**
 * Create (but do not start) a cable server. `listen(port)` binds
 * 127.0.0.1 — loopback is the cable's trust boundary, always.
 */
export function createCableServer({ log = () => {} } = {}) {
  /** @type {Map<string, object>} */
  const machines = new Map();
  let nextId = 1;

  function appendConsole(machine, bytes) {
    machine.buffer = Buffer.concat([machine.buffer, bytes]);
    if (machine.buffer.length > CONSOLE_BUFFER_CAP) {
      const drop = machine.buffer.length - CONSOLE_BUFFER_CAP;
      machine.buffer = machine.buffer.subarray(drop);
      machine.bufferStart += drop;
    }
  }

  function label(machine) {
    return machine.name ?? machine.pc ?? machine.id;
  }

  function onCableMessage(machine, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not ours
    }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.cable === 'hello') {
      machine.name = typeof msg.name === 'string' ? msg.name : null;
      machine.octet = Number.isInteger(msg.octet) ? msg.octet : null;
      machine.pc = typeof msg.pc === 'string' ? msg.pc : null;
      machine.build = typeof msg.build === 'string' ? msg.build : null;
      log(`[cable] hello: ${label(machine)}`);
      return;
    }
    if (msg.cable === 'tx' && typeof msg.data === 'string') {
      appendConsole(machine, Buffer.from(msg.data, 'base64'));
    }
  }

  /** Resolve `to`/`from` keys: exact id, TAN name, or pc-id match. */
  function findMachine(key) {
    if (key === null) return null;
    for (const m of machines.values()) {
      if (m.id === key || m.name === key || m.pc === key) return m;
    }
    return null;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/machines') {
      const list = [...machines.values()].map((m) => ({
        id: m.id,
        name: m.name,
        octet: m.octet,
        pc: m.pc,
        build: m.build,
        connectedAt: m.connectedAt,
        consoleBytes: m.bufferStart + m.buffer.length,
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(list, null, 2));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/console') {
      const machine = findMachine(url.searchParams.get('from'));
      if (machine === null) {
        res.statusCode = 404;
        res.end('no such machine (GET /machines lists them)\n');
        return;
      }
      const total = machine.bufferStart + machine.buffer.length;
      const sinceRaw = Number(url.searchParams.get('since'));
      const since = Math.max(
        machine.bufferStart,
        Number.isFinite(sinceRaw) ? sinceRaw : machine.bufferStart,
      );
      const slice = machine.buffer.subarray(
        Math.min(since - machine.bufferStart, machine.buffer.length),
      );
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('x-console-offset', String(total));
      res.end(slice);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/rx') {
      const machine = findMachine(url.searchParams.get('to'));
      if (machine === null) {
        res.statusCode = 404;
        res.end('no such machine (GET /machines lists them)\n');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const msg = JSON.stringify({ cable: 'rx', data: body.toString('base64') });
        machine.socket.write(wsFrame(1, Buffer.from(msg)));
        res.end(`sent ${body.length} bytes to ${label(machine)}\n`);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/spawn') {
      const machine = findMachine(url.searchParams.get('to'));
      if (machine === null) {
        res.statusCode = 404;
        res.end('no such machine (GET /machines lists them)\n');
        return;
      }
      const kind = url.searchParams.get('kind');
      if (kind !== 'tab' && kind !== 'rack') {
        res.statusCode = 400;
        res.end("kind must be 'tab' or 'rack'\n");
        return;
      }
      const msg = JSON.stringify({ cable: 'spawn', kind });
      machine.socket.write(wsFrame(1, Buffer.from(msg)));
      res.end(`spawn ${kind} sent to ${label(machine)}\n`);
      return;
    }
    res.statusCode = 404;
    res.end('agent cable: GET /machines, GET /console?from=, POST /rx?to=, POST /spawn?to=&kind=\n');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/cable' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const machine = {
      id: `m${nextId++}`,
      socket,
      name: null,
      octet: null,
      pc: null,
      build: null,
      connectedAt: Date.now(),
      buffer: Buffer.alloc(0),
      bufferStart: 0,
      parser: new FrameParser(),
    };
    machines.set(machine.id, machine);
    log(`[cable] connected: ${machine.id}`);

    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = machine.parser.feed(chunk);
      } catch (err) {
        log(`[cable] ${label(machine)}: ${String(err)} — closing`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.opcode === 1) onCableMessage(machine, frame.payload.toString('utf8'));
        else if (frame.opcode === 9) socket.write(wsFrame(10, frame.payload)); // ping→pong
        else if (frame.opcode === 8) socket.end(wsFrame(8, Buffer.alloc(0)));
        // binary (2) unused in v1; continuations unsupported (JSON fits one frame)
      }
    });
    const drop = () => {
      if (machines.delete(machine.id)) log(`[cable] disconnected: ${label(machine)}`);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  return {
    server,
    machines,
    /** Bind loopback; resolves with the actual port (0 = ephemeral). */
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : port);
        });
      });
    },
    close() {
      for (const m of machines.values()) m.socket.destroy();
      machines.clear();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// ---- CLI --------------------------------------------------------------

const runDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  const i = process.argv.indexOf('--port');
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  const port = Number.isInteger(v) && v > 0 && v < 65536 ? v : 8737;
  const cable = createCableServer({ log: (line) => console.log(line) });
  void cable.listen(port).then((p) => {
    console.log(`agent cable listening on http://127.0.0.1:${p}`);
    console.log('  GET /machines · GET /console?from=<id> · POST /rx?to=<id>');
  });
}

/**
 * EthernetSwitch unit tests (Phase 14 M3a).
 */

import { describe, it, expect } from 'vitest';
import { EthernetSwitch } from '../../src/net/switch.js';

const MAC_A = [0x02, 0xaa, 0, 0, 0, 1];
const MAC_B = [0x02, 0xbb, 0, 0, 0, 2];
const MAC_C = [0x02, 0xcc, 0, 0, 0, 3];
const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function frame(dst: readonly number[], src: readonly number[], payloadLen = 50): Uint8Array {
  const f = new Uint8Array(14 + payloadLen);
  f.set(dst, 0);
  f.set(src, 6);
  f[12] = 0x08; // ethertype IPv4, arbitrary
  f[13] = 0x00;
  return f;
}

interface TestPort {
  received: Uint8Array[];
  port: ReturnType<EthernetSwitch['attach']>;
}

function attach(sw: EthernetSwitch, name: string): TestPort {
  const received: Uint8Array[] = [];
  const port = sw.attach({ name, onFrame: (f) => received.push(f) });
  return { received, port };
}

describe('EthernetSwitch', () => {
  it('floods broadcast to every port except the sender', () => {
    const sw = new EthernetSwitch();
    const a = attach(sw, 'a');
    const b = attach(sw, 'b');
    const c = attach(sw, 'c');
    a.port.transmit(frame(BCAST, MAC_A));
    expect(a.received).toHaveLength(0);
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
  });

  it('learns source MACs and delivers unicast to the learned port only', () => {
    const sw = new EthernetSwitch();
    const a = attach(sw, 'a');
    const b = attach(sw, 'b');
    const c = attach(sw, 'c');
    a.port.transmit(frame(BCAST, MAC_A)); // teach the switch where A lives
    b.port.transmit(frame(MAC_A, MAC_B));
    expect(a.received).toHaveLength(1);   // the unicast (A's own broadcast never echoes)
    expect(c.received).toHaveLength(1);   // only the original broadcast
    expect(a.received[0]!.slice(0, 6)).toEqual(new Uint8Array(MAC_A));
  });

  it('floods unknown unicast', () => {
    const sw = new EthernetSwitch();
    const a = attach(sw, 'a');
    const b = attach(sw, 'b');
    const c = attach(sw, 'c');
    a.port.transmit(frame(MAC_C, MAC_A)); // C's MAC never seen yet
    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
  });

  it('drops runt frames and counts them', () => {
    const sw = new EthernetSwitch();
    const a = attach(sw, 'a');
    const b = attach(sw, 'b');
    a.port.transmit(new Uint8Array(10));
    expect(b.received).toHaveLength(0);
    expect(sw.runtsDropped).toBe(1);
  });

  it('detach removes the port and forgets its MACs', () => {
    const sw = new EthernetSwitch();
    const a = attach(sw, 'a');
    const b = attach(sw, 'b');
    const c = attach(sw, 'c');
    b.port.transmit(frame(BCAST, MAC_B)); // learn B
    b.port.detach();
    a.port.transmit(frame(MAC_B, MAC_A)); // B gone → unknown unicast → flood
    expect(b.received).toHaveLength(0);
    expect(c.received).toHaveLength(2);   // broadcast + flooded unicast
    expect(sw.describe().ports).toEqual(['a', 'c']);
  });
});

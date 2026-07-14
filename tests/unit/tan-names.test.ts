/**
 * The `.tabs` namespace (Phase 15 M4).
 *
 * The whole design leans on one property: **a tab's name is a pure
 * function of its address**. That is what lets the DNS host answer
 * without asking anyone, the browser title a tab before a frame is
 * sent, and — the load-bearing one — `ping` resolve a name with ktcp
 * stopped, from a table compiled into it.
 *
 * Which means the C table and the TS table must never drift. If they
 * do, `ping cat` and `nslookup cat.tabs` quietly disagree about who
 * `cat` is, and nothing else would catch it. So: pinned here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DNS_NAME,
  GATEWAY_NAME,
  OCTET_MAX,
  OCTET_MIN,
  TAB_NAMES,
  addressForName,
  allKnownHosts,
  nameForOctet,
} from '../../src/net/tan-names.js';

/** Pull the `tab_names[]` initialiser out of the guest C source. */
function cNameTable(): string[] {
  const src = readFileSync(resolve('web/guest/ping.c'), 'ascii');
  const start = src.indexOf('static char *tab_names[TAB_COUNT] = {');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('};', start));
  return [...body.matchAll(/"([a-z]+)"/g)].map((m) => m[1] ?? '');
}

describe('tan-names — the table', () => {
  it('covers exactly the lease range, one name per octet', () => {
    expect(TAB_NAMES).toHaveLength(OCTET_MAX - OCTET_MIN + 1);
    expect(TAB_NAMES).toHaveLength(184);
  });

  it('has no duplicates and never collides with the fixed residents', () => {
    expect(new Set(TAB_NAMES).size).toBe(TAB_NAMES.length);
    expect(TAB_NAMES).not.toContain(GATEWAY_NAME); // elk is the gateway
    expect(TAB_NAMES).not.toContain(DNS_NAME); // owl is the resolver
    expect(TAB_NAMES).not.toContain('gateway');
    expect(TAB_NAMES).not.toContain('dns');
  });

  it('gives the first tabs the friendly names', () => {
    // Allocation picks the lowest free octet, so this IS what the first
    // three tabs are called. It is the whole charm of the feature.
    expect(nameForOctet(16)).toBe('mouse');
    expect(nameForOctet(17)).toBe('cat');
    expect(nameForOctet(18)).toBe('dog');
  });

  it('maps octets and names round-trip', () => {
    for (const octet of [16, 17, 99, 150, 199]) {
      const name = nameForOctet(octet);
      expect(name).not.toBeNull();
      expect(addressForName(name as string)).toEqual([10, 0, 2, octet]);
    }
    expect(nameForOctet(15)).toBeNull(); // below the range
    expect(nameForOctet(200)).toBeNull(); // above it
  });
});

describe('tan-names — resolution', () => {
  it('accepts bare, qualified, and mixed-case names', () => {
    expect(addressForName('cat')).toEqual([10, 0, 2, 17]);
    expect(addressForName('cat.tabs')).toEqual([10, 0, 2, 17]);
    expect(addressForName('CAT.TABS')).toEqual([10, 0, 2, 17]);
    expect(addressForName('cat.tabs.')).toEqual([10, 0, 2, 17]); // trailing dot
  });

  it('knows the permanent residents', () => {
    expect(addressForName('elk')).toEqual([10, 0, 2, 2]); // ELK-S
    expect(addressForName('elk.tabs')).toEqual([10, 0, 2, 2]);
    expect(addressForName('gateway')).toEqual([10, 0, 2, 2]);
    expect(addressForName('owl')).toEqual([10, 0, 2, 3]);
    expect(addressForName('dns')).toEqual([10, 0, 2, 3]);
  });

  it('leaves the real internet alone', () => {
    // Anything with further structure is not ours — it must fall
    // through to DoH, or the guest could never reach the web.
    expect(addressForName('example.com')).toBeNull();
    expect(addressForName('cat.example.com')).toBeNull();
    expect(addressForName('www.cat.tabs')).toBeNull(); // no sub-tabs
    expect(addressForName('narwhal')).toBeNull(); // not on the list
    expect(addressForName('')).toBeNull();
  });

  it('allKnownHosts covers every tab plus the residents', () => {
    const hosts = allKnownHosts();
    expect(hosts.length).toBe(TAB_NAMES.length + 4); // elk, gateway, owl, dns
    expect(hosts.find((h) => h.name === 'mouse')?.dotted).toBe('10.0.2.16');
    expect(hosts.find((h) => h.name === 'elk')?.dotted).toBe('10.0.2.2');
  });
});

describe('tan-names — the C table must not drift from the TS table', () => {
  it('ping.c carries exactly the same names, in the same order', () => {
    // ping resolves names from this compiled-in table because it cannot
    // use DNS (ktcp must be stopped for it to own the NIC). If the two
    // lists disagree, `ping cat` reaches a different machine than
    // `nslookup cat.tabs` says it should — and nothing else would tell
    // us. Hence this test.
    expect(cNameTable()).toEqual([...TAB_NAMES]);
  });

  it('ping.c declares the same octet base and count', () => {
    const src = readFileSync(resolve('web/guest/ping.c'), 'ascii');
    expect(src).toContain(`#define TAB_OCTET_MIN ${OCTET_MIN}`);
    expect(src).toContain(`#define TAB_COUNT     ${TAB_NAMES.length}`);
  });
});

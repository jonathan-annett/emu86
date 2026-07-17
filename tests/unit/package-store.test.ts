/**
 * PackageStore unit tests (multi-PC brief M3) — the fake-indexeddb
 * harness, one fresh IDBFactory per test.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { PackageStore, type RackPackage } from '../../web/package-store.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function pkg(id: string, name: string, createdAt: number): RackPackage {
  return {
    packageId: id,
    name,
    createdAt,
    members: [
      { label: 'mouse', stateId: `named-${id}-a` },
      { label: 'cat', stateId: `named-${id}-b` },
    ],
  };
}

describe('PackageStore', () => {
  it('round-trips a package with its members', async () => {
    const store = new PackageStore();
    await store.put(pkg('p1', 'two-node telnet lab', 1000));
    const back = await store.get('p1');
    expect(back).toEqual(pkg('p1', 'two-node telnet lab', 1000));
    expect(await store.get('nope')).toBeNull();
  });

  it('lists newest first', async () => {
    const store = new PackageStore();
    await store.put(pkg('old', 'old', 1000));
    await store.put(pkg('new', 'new', 2000));
    expect((await store.list()).map((p) => p.packageId)).toEqual(['new', 'old']);
  });

  it('overwrites in place and deletes the manifest row alone', async () => {
    const store = new PackageStore();
    await store.put(pkg('p1', 'v1', 1000));
    await store.put({ ...pkg('p1', 'v2', 2000), members: [] });
    expect((await store.get('p1'))?.name).toBe('v2');
    await store.delete('p1');
    expect(await store.get('p1')).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});

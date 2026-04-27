# IndexedDBPageStore — Implementation Report

## Summary

- New file: `src/memory/idb-page-store.ts` — `IndexedDBPageStore` implementing the existing `PageStore` interface against the browser IndexedDB API.
- New tests: `tests/unit/idb-page-store.test.ts` — 15 cases covering lifecycle, round-trip, mutation independence, edge cases, and `PagedMemory` integration.
- Polyfill: `fake-indexeddb@6.2.5` added as a dev dependency. Imported via `fake-indexeddb/auto` from the test file; reset to a fresh `IDBFactory` per test.
- Test counts:
  - Baseline (before this work): 380 unit tests passing.
  - After: **395 unit tests passing** (+15 new). All green.
  - `npm run typecheck`: clean (strict TS, no `any` / `as unknown as` / `@ts-ignore`).
  - SST corpus: still green (this work doesn't touch CPU/opcode code; verified at the end).
- No interface or architectural changes. `PageStore`, `PagedMemory`, `cpu.ts`, and everything in `src/core/` / `src/runtime/` are untouched. The barrel `src/memory/index.ts` gains one export line.

## Polyfill verification

Performed before installing anything, per the brief's "stop and ask if abandoned" rule:

| Check | Value |
| --- | --- |
| Latest version | `6.2.5` |
| Last published | 5 months before today (Nov 2025) |
| Last `time.modified` (npm metadata) | `2025-11-07` |
| Weekly downloads (week of 2026-04-19 → 2026-04-25) | `3,081,045` |
| Dependencies | none |
| Total versions | 52 (consistent release cadence since 2015) |
| Repo / README | active on `dumbmatter/fakeIndexedDB`, ESM-first, types shipped |

Calls made:

- `npm view fake-indexeddb` for version and last-publish.
- `https://api.npmjs.org/downloads/point/last-week/fake-indexeddb` for downloads.
- README on GitHub for current API (the `fake-indexeddb/auto` side-effect import; `IDBFactory` constructor for per-test reset).

**Decision: actively maintained, install and use.** Three-million-weekly-download package with no abandonment markers, regular releases, zero deps, official `fake-indexeddb/auto` entry that does exactly what the brief described. No polyfill fallback needed.

## Implementation notes

### Lifecycle / `ready()`

- The constructor is pure: it stores the database name and nothing else.
- `ready()` is the lazy entry point. Idempotent: it caches the in-flight `Promise<IDBDatabase>` and returns the same one to all callers (concurrent or subsequent). The test `ready() is idempotent` asserts identity (`p1 === p2`) and same DB resolution.
- `close()` invalidates the cache so the next op reopens. The test `ready() after close() re-opens a fresh connection` confirms this.
- `db.onclose` clears our cache too — that's the path browsers take when storage is evicted or another tab triggers a `versionchange`. Without this, we'd hold a dead handle across the next op.

### Schema setup

- Object store name `pages`, schema version `1`, hardcoded.
- `createObjectStore` happens inside `onupgradeneeded`. That handler is attached on the `IDBOpenDBRequest` synchronously after `open()` returns, before the request runs to its first event — the #1 IDB beginner trap (per the brief's "watch out for"), defended against by code shape.
- Out-of-line keys: `put(value, pageId)`. No `keyPath`, no schema bookkeeping.

### `save()` and `clear()`

- Each call opens a new short-lived `readwrite` transaction. PagedMemory's write-back loop awaits between saves anyway, so a long-lived transaction would auto-commit before the next save landed.
- Saved data is **copied before the transaction** with `new Uint8Array(data)`. Mirrors `InMemoryPageStore.save`. Verified by the `mutating the input buffer after save() does not affect persisted data` test, which mutates the input post-save and asserts the persisted bytes are unchanged.
- Both methods await `transaction.oncomplete`, not `request.onsuccess`. For single-request transactions this is the cleanest pattern and the brief's recommendation: `oncomplete` fires only after every queued op landed and the transaction durably committed. `onerror` and `onabort` reject with the underlying error.

### `loadAll()` cursor adapter

- Uses `objectStore.openCursor()` with a promise-per-step adapter (per the brief's "keep it simple — don't try to be clever about prefetching"). No batching, no prefetch, no `getAll()`.
- The shape is "stage next promise, then deliver current cursor": `request.onsuccess` first replaces `pending` with a fresh promise (so the *next* `onsuccess` triggered by `cursor.continue()` has somewhere to land), then resolves the previous one. Without this ordering, you race the next cursor event against your handler's bookkeeping.
- `cursor.continue()` is called **before** `yield`, so a request is always pending across the yield. That's what keeps the IDB transaction from auto-committing while the consumer's iterator body runs (provided that body does only synchronous or IDB-only work — see "browser caveats" below).
- Defensive runtime checks: `typeof key !== 'number'` and `value instanceof Uint8Array` throw rather than silently mis-coerce. We don't trust IDBValidKey or `cursor.value: any`. This catches schema tampering (DevTools edits, malformed migrations) loudly rather than mid-emulation.
- Loaded buffers are copied with `new Uint8Array(value)` before yielding. Verified by the `mutating a loaded buffer does not bleed into a later loadAll` test.

### Error handling

- `request.onerror` rejects with `request.error`; `transaction.onerror`/`onabort` rejects with `transaction.error`. Each path has a fallback `Error` for the (unlikely) case where `error` is `null`.
- No swallowing: if `save()` rejects, `PagedMemory.flushDirty` propagates the rejection; the page won't have been removed from `dirty` (it was already cleared at batch grab time, but a subsequent write will re-dirty it, matching the documented re-add behavior in the existing `paged-memory.test.ts` race test).

### What I didn't add

- No retry, no batching, no compression, no caching layer in front of IDB. The brief was explicit: this is a thin adapter.
- No schema-version migration code. The brief says v1 only; a v2 is "a new brief".

## Browser caveats

These are things that pass under `fake-indexeddb` but worth a follow-up sanity check in a real browser:

- **Cursor-iterator + non-IDB awaits.** The current loop calls `cursor.continue()` before `yield`. If a future consumer interleaves a non-IDB await (`await fetch(...)`, `await new Promise(setTimeout)`) inside its `for await` body, real-browser IDB will commit the transaction the moment all pending requests resolve and control returns to the event loop. The next iteration's call to `cursor.continue()` would then throw `InvalidStateError`. The only in-tree consumer is `PagedMemory.hydrate`, which iterates with pure-sync work per item — safe in practice. Documented in the JSDoc on `loadAll()`.
- **`structuredClone` strictness.** `Uint8Array` round-trips correctly under both fake-indexeddb and real browsers. We *don't* store `Buffer` (Node-only `Uint8Array` subclass) — `save()` always copies into a freshly-allocated plain `Uint8Array` first, so the structured clone always sees the canonical shape. The `round-trips a 4096-byte page` and `100+ pages` tests confirm byte-identical round-trip in the polyfill; expected to behave identically in browsers.
- **`IDBOpenDBRequest.onblocked`.** The polyfill rarely exercises this path (no real concurrent connections from other tabs in a Node process). Real browsers will fire `onblocked` if another connection holds the DB at an older version. We reject `ready()` with a clear error in that case; recovery is out of scope.
- **Quota errors.** Out of scope per the brief; would manifest as a transaction `onerror` with a `QuotaExceededError` in real browsers, which our error path surfaces.
- **Storage eviction → `db.onclose`.** Wired up, but never fires in fake-indexeddb. Real-browser behavior is best validated by manually clearing the IDB in DevTools mid-run and watching the next op re-open cleanly.

## Verification

Commands run, in order:

```bash
# Polyfill maintenance check
npm view fake-indexeddb                              # latest, deps, last-publish
npm view fake-indexeddb time.modified time.created   # 2025-11-07 modified
curl https://api.npmjs.org/downloads/point/last-week/fake-indexeddb  # 3.08M/wk

# Install
npm install --save-dev fake-indexeddb                # added 1 package, 0 deps

# Tight feedback loop during development
npx vitest run tests/unit/idb-page-store.test.ts     # 15/15 passing
npx vitest run tests/unit/                           # 395/395 passing
                                                     # (380 baseline + 15 new)

# Typecheck (strict, both src and tests projects)
npm run typecheck                                    # clean

# Final sanity check on corpus (this work doesn't touch CPU/opcode code,
# but the brief asks to verify)
npm run test:sst                                     # green (see below)
```

### `npx vitest run tests/unit/` final tail:

```
 Test Files  22 passed (22)
      Tests  395 passed (395)
   Duration  ~1.7s
```

### `npx vitest run tests/unit/idb-page-store.test.ts` final tail:

```
 ✓ tests/unit/idb-page-store.test.ts  (15 tests) ~50ms

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

### `npm run typecheck`:

Exit 0, no output. (`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`)

### `npm run test:sst` final tail:

```
 Test Files  2 passed (2)
      Tests  329 passed (329)
   Duration  152.44s
```

329 corpus files green (one `it()` per opcode file, aggregating that file's
thousands of cases internally — see the comment in `tests/sst/corpus.test.ts`).
This work doesn't touch any CPU/opcode/run-loop code, so a regression here
would have been a surprise; verified it's still clean.

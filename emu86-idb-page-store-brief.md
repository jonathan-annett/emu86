# emu86 — Agent Brief: IndexedDBPageStore

## TL;DR

Implement an IndexedDB-backed `PageStore` for browser-side persistence of memory pages. Test it in Node via an actively-maintained IDB polyfill (or fall back to a hand-built in-memory mock if polyfills are stale). Ship a green test run plus a report at `IDB_PAGE_STORE_REPORT.md`.

You are working in `emu86/`. Read `README.md`, `CORPUS_VALIDATION_REPORT.md`, and `src/memory/page-store.ts` before writing anything. The `PageStore` interface is already defined and used by `PagedMemory`; your job is to implement it against IndexedDB. No interface changes.

## Hard rules

1. **Don't break existing tests.** The current state is 380 unit tests + 3,007,000 corpus cases all passing. Both must stay green. Run `npm test` after every meaningful change. The corpus run is slow but `npx vitest run tests/unit/` is fast — use that as your tight feedback loop and the corpus only at the end.
2. **No interface changes to `PageStore` or `Memory`.** The interface in `src/memory/page-store.ts` is the contract. If you find yourself wanting to change it, stop and ask.
3. **No architectural changes to `PagedMemory`, `cpu.ts`, or anything in `src/core/` / `src/runtime/`.** This work should be additive — one new file in `src/memory/`, optionally one new test file, one new dev dep. That's it.
4. **`cpu.step()` stays pure synchronous.** Same constraint as always.
5. **Strict TypeScript stays strict.** No `any`, no `as unknown as`, no `// @ts-ignore`.
6. **The implementation must work in real browsers, not just Node.** The polyfill is for testing only. Don't reach for Node-only APIs (no `fs`, no `Buffer`, no `process`). Use only what the browser's IndexedDB spec exposes.

## Scope

A single new file: `src/memory/idb-page-store.ts`, exporting an `IndexedDBPageStore` class implementing the existing `PageStore` interface:

```ts
export interface PageStore {
  readonly readonly: boolean;
  loadAll(): AsyncIterable<readonly [pageId: number, data: Uint8Array]>;
  save(pageId: number, data: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}
```

Plus tests in `tests/unit/idb-page-store.test.ts`. Plus a barrel export update in `src/memory/index.ts`.

That is the entire deliverable. No new abstractions, no clever caching, no compression, no batching schemes — `PagedMemory` already does the batching. This module is a thin adapter from "Uint8Array keyed by integer" to "IndexedDB object store."

## Design

### Database shape

- One database per `IndexedDBPageStore` instance. Database name is constructor-configurable (default `emu86-pages`); useful so multiple emulator instances on one origin don't collide.
- One object store inside that database. Hardcoded name (`pages`).
- Keys are page IDs (integers). Values are `Uint8Array`s.
- `keyPath` is not used; use out-of-line keys (pass `pageId` as the second arg to `put`).
- Schema version: 1. Don't worry about upgrades yet — when a v2 ever exists, that's a new brief.

### Lifecycle

- The constructor doesn't open the database. Opening is async and shouldn't be a constructor side effect.
- A `ready()` method (or lazy on-first-use) handles opening + schema creation. Keep it idempotent — multiple calls return the same promise.
- The class should hold the open `IDBDatabase` reference for the lifetime of the instance. Don't reopen on every call; that'd thrash. One transaction per `save` / `clear` is fine.
- Provide a `close()` method that closes the database. Useful in tests to verify clean teardown.

### Operations

- `loadAll()` opens a read-only transaction, opens a cursor on the object store, and yields `[pageId, Uint8Array]` pairs as it goes. Use the IDB cursor API — don't `getAll()` then iterate, because for a fully-populated 8086 (256 pages × 4 KiB = 1 MiB) or 286 (4096 pages × 4 KiB = 16 MiB) you'd materialise the whole thing at once. Cursor streaming is the point.
- `save(pageId, data)` opens a read-write transaction, calls `put(data, pageId)`, awaits transaction completion. **Copy the input `Uint8Array`** before storing — `PagedMemory` may mutate the original buffer after this call returns. The existing `InMemoryPageStore` does this; match the pattern.
- `clear()` opens a read-write transaction and calls `clear()` on the object store.
- `readonly` field: always `false` for this implementation.

### Error handling

- IndexedDB operations can fail for many reasons (quota exceeded, browser-side eviction of the database, blocked upgrade events). Wrap each operation's promise correctly: resolve on success, reject with the underlying `IDBRequest.error` (or transaction `.error`) on failure.
- Don't swallow errors. If `save()` fails, callers (the write-back loop in `PagedMemory`) need to know. The write-back loop will then re-add the page to dirty on the next iteration; that's the right behavior.
- A common gotcha: `transaction.oncomplete` fires *after* `request.onsuccess`, but `transaction.onerror` doesn't necessarily mean the request failed (could be a later request in the same transaction). Hook both `request.onsuccess`/`onerror` and `transaction.oncomplete`/`onerror` thoughtfully — for single-request transactions, awaiting `transaction.oncomplete` is the cleanest pattern.

### Concurrency

- Multiple `save()` calls in flight simultaneously is fine — IDB serialises writes within a transaction scope. No application-level locking needed.
- Don't open a single long-lived read-write transaction; per-operation transactions are correct because `PagedMemory`'s write-back loop awaits between saves.
- `clear()` racing with `save()` is the caller's problem (and `PagedMemory` doesn't do this), but make it well-defined: each call is its own transaction, IDB orders them by request time.

## Testing strategy

### Polyfill check

First, verify the IDB polyfill landscape *now*, not from training data:

```bash
npm view fake-indexeddb
# Check: latest version, last publish date, weekly downloads
```

If the polyfill looks actively maintained (recent publish, healthy downloads, no obvious abandonment notice in README), use it as a dev dependency. Run `npm install --save-dev fake-indexeddb` and import it in the test file.

If it looks abandoned or you can't find a credible replacement, **stop and ask the human before proceeding**. Do not silently fall back to a hand-rolled mock; the human explicitly conditioned polyfill use on confirmed maintenance.

The polyfill should expose `indexedDB` as a global when imported. Typical setup:

```ts
import 'fake-indexeddb/auto';
```

(or whatever the current API is — verify against the polyfill's current README, not training data).

### What to test

Match the depth of the existing `tests/unit/paged-memory.test.ts` — that's the bar. Specifically:

- **Lifecycle**: `ready()` is idempotent (multiple calls share a promise). `close()` followed by another operation either re-opens or throws cleanly (your call which, but be consistent and document).
- **Round-trip**: `save(id, data)` then `loadAll()` returns the same data. Verify byte-for-byte equality.
- **Multiple pages**: save several pages, load all, assert all present and correct.
- **Overwrite**: `save(id, dataA)` then `save(id, dataB)` then `loadAll()` returns `dataB`.
- **Independence from input mutation**: save a Uint8Array, mutate it, load — saved version should be unchanged. (This catches a missing copy-on-save.)
- **Independence from output mutation**: load a page, mutate the loaded array, load again — the second load should be unchanged. (This catches a shared-buffer leak via cursors.)
- **clear()**: save several, clear, loadAll yields nothing.
- **Empty load**: brand new store, `loadAll()` yields nothing without throwing.
- **Large page**: save and load a 4096-byte page filled with non-zero data.
- **Many pages**: save 100+ pages, load all, count matches.
- **Multiple databases isolated**: two `IndexedDBPageStore` instances with different db names don't see each other's data.
- **Integration with `PagedMemory`**: hydrate a `PagedMemory` from a pre-populated IDB store, verify reads return correct data; write through `PagedMemory`, flush, instantiate a fresh `PagedMemory` against the same store, hydrate, verify writes survived. This is the load-bearing test for the whole "lazy write-behind to IDB" promise from v0.

### What not to test

- Don't test IDB itself. Don't test that `put` works. Trust the polyfill / browser.
- Don't test `PagedMemory` behavior — that's already covered. Test only the integration boundary.
- Don't test browser-specific quota errors or eviction. Out of scope for unit tests; those need browser-side validation.

## Watch out for

- **`IDBOpenDBRequest` quirks.** Opening a database returns a request that fires `onupgradeneeded` (for first-time setup or version bumps), then `onsuccess` (after upgrade or if no upgrade was needed). Object stores must be created inside `onupgradeneeded`. Failing to attach the handler before the request runs is the #1 IDB beginner bug.
- **`structuredClone` on `Uint8Array`.** IDB serialises values via the structured clone algorithm. `Uint8Array` round-trips correctly, but if you accidentally store a `Buffer` (Node-specific subclass) it might not load back as a `Uint8Array`. Always store plain `Uint8Array`. The polyfill is more forgiving than real browsers; test against the polyfill's strictness setting if it has one.
- **Transaction auto-commit.** A transaction commits when control returns to the event loop with no pending requests. Don't `await` non-IDB work in the middle of a transaction — it'll auto-commit before your next IDB call lands. If you need to await, structure your code so each transaction is a self-contained sync block of IDB calls.
- **Cursor iteration is request-driven, not iterator-driven.** Wrapping a cursor in an `AsyncIterable` requires a small adapter: each `cursor.continue()` triggers another `onsuccess` callback. Convert that to a promise-per-step pattern. Keep it simple — don't try to be clever about prefetching.
- **Missing object store.** If someone deletes the IDB out-of-band (DevTools → Storage → Clear), your next operation throws. Acceptable to surface that; don't try to auto-recover.
- **Test cleanup.** `fake-indexeddb` (or whatever polyfill) is global state in Node. Tests need to reset it between runs (the polyfill usually has a `FDBFactory.reset()` or equivalent — check current docs). Otherwise tests bleed into each other and you'll get bizarre flakes.

## Stop and ask

- If the polyfill landscape looks bad (no credible maintained option) — **don't fall back silently**, ask
- If you find yourself wanting to change `PageStore`, `PagedMemory`, or anything in `src/core/`/`src/cpu8086/`/`src/runtime/`
- If `cpu.step()` starts wanting to be async (it shouldn't — this work shouldn't go near `cpu.ts`)
- If you find a real bug in `PagedMemory` itself (rare but possible — its tests don't cover every IDB-shaped edge case)

## Definition of done

- `src/memory/idb-page-store.ts` implements `PageStore` against IndexedDB
- `src/memory/index.ts` exports it
- `tests/unit/idb-page-store.test.ts` covers the test list above, all green
- `npm test` (full unit suite) shows ≥ 393 passing tests (380 baseline + ~13 new)
- `npm run typecheck` is clean
- Full corpus run still green (sanity check; this work shouldn't affect it but verify)
- A report at the project root: `IDB_PAGE_STORE_REPORT.md` with these sections:
  - **Summary**: test counts, polyfill chosen (and version), pass status
  - **Polyfill verification**: what you checked (publish date, downloads, README), and the call you made
  - **Implementation notes**: any non-obvious choices, especially around transactions, cursor iteration, and error handling
  - **Browser caveats**: anything you know works in the polyfill but might behave differently in real browsers (worth a follow-up browser-side check later)
  - **Verification**: exact commands run and their output

## Reference

- IDB spec / MDN: trust current MDN docs over training data, the API has been stable but the *recommended* patterns have evolved
- The existing `InMemoryPageStore` in `src/memory/page-store.ts` — your impl should feel like a sibling of that one, same shape, same defensive copying, same error discipline
- `tests/unit/paged-memory.test.ts` — the depth bar for tests

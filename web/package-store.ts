/**
 * PackageStore — the `emu86-packages` IDB tenant (multi-PC brief M3).
 *
 * One row per infrastructure package: a name and the member list —
 * each member a pointer at a NAMED SAVE in `emu86-machines` plus its
 * rail label. Deliberately its own database, not a version bump of
 * the machine store: packages are a manifest layer over states, and
 * cross-DB writes here are honest about their tear semantics — the
 * member states land first, the manifest last, so an interrupted
 * save leaves only ordinary named saves (visible in every picker,
 * deletable) and never a manifest pointing at nothing.
 *
 * A package references CAPTURED states: it is not live-synced to the
 * rack afterwards — re-save to update (the brief records this).
 *
 * Class shape mirrors MachineStore: lazy memoized ready(), onclose
 * self-heal, queue-everything-before-awaiting.
 */

export interface RackPackageMember {
  /** Rail label at save time (the PC's TAN name, usually). */
  label: string | null;
  /** The member's named save in `emu86-machines`. */
  stateId: string;
}

export interface RackPackage {
  packageId: string;
  name: string;
  createdAt: number;
  members: RackPackageMember[];
}

const DATABASE_NAME = 'emu86-packages';
const SCHEMA_VERSION = 1;
const PACKAGE_STORE = 'packages';

export class PackageStore {
  readonly #databaseName: string;
  #db: IDBDatabase | null = null;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(databaseName: string = DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  ready(): Promise<IDBDatabase> {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.#databaseName, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PACKAGE_STORE)) {
          db.createObjectStore(PACKAGE_STORE, { keyPath: 'packageId' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        this.#db = db;
        db.onclose = () => {
          if (this.#db === db) {
            this.#db = null;
            this.#openPromise = null;
          }
        };
        resolve(db);
      };
      req.onerror = () => {
        this.#openPromise = null;
        reject(req.error ?? new Error('PackageStore: open failed'));
      };
      req.onblocked = () => {
        this.#openPromise = null;
        reject(new Error('PackageStore: open blocked by another connection'));
      };
    });
    return this.#openPromise;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#openPromise = null;
  }

  /** Insert or overwrite one package row. */
  async put(pkg: RackPackage): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(PACKAGE_STORE, 'readwrite');
    tx.objectStore(PACKAGE_STORE).put(pkg);
    await awaitTransaction(tx);
  }

  async get(packageId: string): Promise<RackPackage | null> {
    const db = await this.ready();
    const tx = db.transaction(PACKAGE_STORE, 'readonly');
    const row = await awaitRequest<RackPackage | undefined>(
      tx.objectStore(PACKAGE_STORE).get(packageId),
    );
    return row ?? null;
  }

  /** Every package, newest first. */
  async list(): Promise<RackPackage[]> {
    const db = await this.ready();
    const tx = db.transaction(PACKAGE_STORE, 'readonly');
    const rows = await awaitRequest<RackPackage[]>(
      tx.objectStore(PACKAGE_STORE).getAll(),
    );
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drop the manifest row alone — the caller owns the member states
   *  (delete them first; a tear then leaves plain named saves). */
  async delete(packageId: string): Promise<void> {
    const db = await this.ready();
    const tx = db.transaction(PACKAGE_STORE, 'readwrite');
    tx.objectStore(PACKAGE_STORE).delete(packageId);
    await awaitTransaction(tx);
  }
}

function awaitRequest<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('PackageStore: request failed'));
  });
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('PackageStore: transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('PackageStore: transaction aborted'));
  });
}

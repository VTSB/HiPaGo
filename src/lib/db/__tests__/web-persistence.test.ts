// @vitest-environment node
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebAdapter } from '../adapters/web';
import { closeDb, persistDb, setDb, withTransaction } from '../adapter';
import { SCHEMA_SQL } from '../schema-sql';
import { enqueueDownload } from '../download-queue';
import {
  addToLibrary,
  addToCollection,
  createCollection,
  moveCollection,
  deleteCollection,
  getCollections,
  getGalleryCollectionIds,
  getLibraryIds,
  LibraryCollectionError,
} from '../library';

// Only redirect the browser WASM URL; all SQLite statements and exports are real.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An asynchronous IndexedDB transport with controllable commit timing/failure. */
function indexedDbTransport() {
  let saved: Uint8Array | undefined;
  const snapshots: Uint8Array[] = [];
  const commits: Array<() => void> = [];
  const transport = {
    hold: false,
    failNext: false,
    abortNext: false,
    snapshots,
    commits,
    get saved() {
      return saved;
    },
    open() {
      const request: Partial<IDBOpenDBRequest> = {};
      queueMicrotask(() => {
        Object.defineProperty(request, 'result', {
          value: {
            transaction: (_store: string, mode: IDBTransactionMode) => {
              const transaction: Partial<IDBTransaction> = {};
              transaction.objectStore = () =>
                ({
                  get: () => {
                    const read: Partial<IDBRequest> = {};
                    queueMicrotask(() => {
                      Object.defineProperty(read, 'result', { value: saved });
                      read.onsuccess?.call(read as IDBRequest, new Event('success'));
                    });
                    return read as IDBRequest;
                  },
                  put: (data: Uint8Array) => {
                    if (mode !== 'readwrite') throw new Error('Not writable');
                    const snapshot = data.slice();
                    snapshots.push(snapshot);
                    const commit = () => {
                      if (transport.abortNext) {
                        transport.abortNext = false;
                        transaction.onabort?.call(
                          transaction as IDBTransaction,
                          new Event('abort'),
                        );
                      } else if (transport.failNext) {
                        transport.failNext = false;
                        Object.defineProperty(transaction, 'error', {
                          value: new Error('Disk full'),
                        });
                        transaction.onerror?.call(
                          transaction as IDBTransaction,
                          new Event('error'),
                        );
                      } else {
                        saved = snapshot;
                        transaction.oncomplete?.call(
                          transaction as IDBTransaction,
                          new Event('complete'),
                        );
                      }
                    };
                    if (transport.hold) commits.push(commit);
                    else queueMicrotask(commit);
                    return {} as IDBRequest;
                  },
                }) as unknown as IDBObjectStore;
              return transaction as IDBTransaction;
            },
            close() {},
          } as unknown as IDBDatabase,
        });
        request.onsuccess?.call(request as IDBOpenDBRequest, new Event('success'));
      });
      return request as IDBOpenDBRequest;
    },
  };
  return transport;
}

let SQL: SqlJsStatic;
let adapter: WebAdapter;
let transport: ReturnType<typeof indexedDbTransport>;
let browser: EventTarget;

beforeAll(async () => {
  SQL = await initSqlJs();
});
beforeEach(async () => {
  transport = indexedDbTransport();
  browser = new EventTarget();
  vi.stubGlobal('indexedDB', transport);
  vi.stubGlobal('window', browser);
  adapter = await WebAdapter.create();
  setDb(adapter);
  await adapter.exec(SCHEMA_SQL);
  await adapter.persist();
});
afterEach(async () => {
  vi.useRealTimers();
  transport.hold = false;
  for (const commit of transport.commits.splice(0)) commit();
  await closeDb();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function persistedIds() {
  const restored = new SQL.Database(transport.saved);
  try {
    return (
      restored.exec('SELECT galleryId FROM favorites ORDER BY galleryId')[0]?.values.flat() ?? []
    );
  } finally {
    restored.close();
  }
}

describe('real web database transaction persistence', () => {
  it('commits naturally simultaneous enqueues and their saved memberships', async () => {
    const outcomes = await Promise.allSettled([
      enqueueDownload({ galleryId: 42, title: 'First', thumbnail: '', tags: {} }),
      enqueueDownload({ galleryId: 43, title: 'Second', thumbnail: '', tags: {} }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(
      await adapter.query('SELECT galleryId, status FROM download ORDER BY galleryId'),
    ).toEqual([
      { galleryId: 42, status: 'queued' },
      { galleryId: 43, status: 'queued' },
    ]);
    expect(persistedIds()).toEqual([42, 43]);
  });

  it('an independent saved mutation survives another transaction rolling back', async () => {
    const entered = deferred();
    const release = deferred();
    const owner = withTransaction(async () => {
      await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (1, ?)', ['now']);
      entered.resolve();
      await release.promise;
      throw new Error('Owner failed');
    });
    const failedOwner = owner.catch((error: Error) => error.message);
    await entered.promise;
    const independent = addToLibrary(99);
    // Give the independent mutation a chance to reach its ownership boundary.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    expect(await failedOwner).toBe('Owner failed');
    await independent;
    expect(await getLibraryIds()).toEqual([99]);
    expect(persistedIds()).toEqual([99]);
  });

  it.each(['explicit', 'timer', 'unload', 'close'] as const)(
    '%s persistence does not interrupt a suspended transaction',
    async (trigger) => {
      const entered = deferred();
      const release = deferred();
      const transaction = withTransaction(async () => {
        await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (7, ?)', ['now']);
        entered.resolve();
        await release.promise;
      });
      // Attach a handler before provoking the old export rollback failure.
      const outcome = transaction.then(
        () => 'committed',
        (error: Error) => error.message,
      );
      await entered.promise;
      let flush: Promise<void> | undefined;
      if (trigger === 'explicit') flush = adapter.persist();
      if (trigger === 'timer') await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      if (trigger === 'unload') browser.dispatchEvent(new Event('beforeunload'));
      if (trigger === 'close') flush = closeDb();
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      expect(await outcome).toBe('committed');
      if (flush) await flush;
      if (trigger === 'timer' || trigger === 'unload') {
        await vi.waitFor(() => expect(persistedIds()).toEqual([7]));
      }
      expect(persistedIds()).toEqual([7]);
    },
  );

  it('returns each generated collection ID after persistence', async () => {
    const first = await createCollection('First');
    const second = await createCollection('Second');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(await getCollections()).toEqual([
      { id: first, name: 'First', parentId: null, count: 0 },
      { id: second, name: 'Second', parentId: null, count: 0 },
    ]);
  });

  it('retries a committed folder snapshot without inserting again and reopens the same ID', async () => {
    const parentId = await createCollection('Parent');
    const execute = vi.spyOn(adapter, 'execute');
    transport.failNext = true;
    const failure = await createCollection('Child', parentId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LibraryCollectionError);
    expect(failure).toMatchObject({ code: 'created-unsaved', message: 'Disk full' });
    const committed = await adapter.query<{ id: number; name: string; parentId: number }>(
      'SELECT id, name, parentId FROM library_collection WHERE name = ?',
      ['Child'],
    );
    expect(committed).toHaveLength(1);
    expect(failure).toHaveProperty('createdCollectionId', committed[0].id);
    const createdId = committed[0].id;
    expect(adapter.dirty).toBe(true);

    transport.failNext = true;
    await expect(persistDb()).rejects.toThrow('Disk full');
    expect(await getCollections()).toEqual([
      { id: parentId, name: 'Parent', parentId: null, count: 0 },
      { id: createdId, name: 'Child', parentId, count: 0 },
    ]);
    await persistDb();
    expect(
      execute.mock.calls.filter(([sql]) => /INSERT INTO library_collection\s*\(/i.test(sql)),
    ).toHaveLength(1);
    await closeDb();
    adapter = await WebAdapter.create();
    setDb(adapter);
    expect(await getCollections()).toEqual([
      { id: parentId, name: 'Parent', parentId: null, count: 0 },
      { id: createdId, name: 'Child', parentId, count: 0 },
    ]);
  });

  it('reopens persisted nested folders after moving and deleting their parent with membership intact', async () => {
    const root = await createCollection('Root');
    const destination = await createCollection('Destination');
    const branch = await createCollection('Branch', root);
    const child = await createCollection('Child', branch);
    await addToCollection([42], branch);
    await addToCollection([42, 43], child);
    await moveCollection(branch, destination);
    await deleteCollection(branch);
    await closeDb();
    adapter = await WebAdapter.create();
    setDb(adapter);
    expect(await getCollections()).toEqual([
      { id: root, name: 'Root', parentId: null, count: 0 },
      { id: destination, name: 'Destination', parentId: null, count: 0 },
      { id: child, name: 'Child', parentId: destination, count: 2 },
    ]);
    expect(await getGalleryCollectionIds(42)).toEqual([child]);
    expect(new Set(await getLibraryIds())).toEqual(new Set([42, 43]));
    expect(persistedIds()).toEqual([42, 43]);
  });

  it('keeps foreign-key enforcement enabled after exporting a snapshot', async () => {
    await adapter.exec(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parentId INTEGER REFERENCES parent(id))',
    );
    await adapter.persist();
    await expect(adapter.execute('INSERT INTO child (parentId) VALUES (123)')).rejects.toThrow(
      /FOREIGN KEY/,
    );
    expect(await adapter.query('SELECT * FROM child')).toEqual([]);
  });

  it('orders in-flight snapshots so an older commit cannot replace a newer database', async () => {
    transport.hold = true;
    await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (1, ?)', ['now']);
    const first = adapter.persist();
    await vi.waitFor(() => expect(transport.commits).toHaveLength(1));
    await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (2, ?)', ['now']);
    const second = adapter.persist();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Only the first write may reach IndexedDB until its commit finishes.
    expect(transport.commits).toHaveLength(1);
    transport.commits.shift()!();
    await first;
    await vi.waitFor(() => expect(transport.commits).toHaveLength(1));
    transport.commits.shift()!();
    await second;
    expect(persistedIds()).toEqual([1, 2]);
  });

  it('rejects failed persistence and retains dirty data for a successful retry', async () => {
    await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (5, ?)', ['now']);
    transport.failNext = true;
    await expect(adapter.persist()).rejects.toThrow('Disk full');
    expect(adapter.dirty).toBe(true);
    await adapter.persist();
    expect(persistedIds()).toEqual([5]);
  });

  it('rejects an aborted IndexedDB commit without losing the retry snapshot', async () => {
    await adapter.execute('INSERT INTO favorites (galleryId, addedAt) VALUES (6, ?)', ['now']);
    transport.abortNext = true;
    await expect(adapter.persist()).rejects.toThrow('IndexedDB transaction aborted');
    expect(adapter.dirty).toBe(true);
    await adapter.persist();
    expect(persistedIds()).toEqual([6]);
  });
});

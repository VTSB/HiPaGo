// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqlState = vi.hoisted(() => {
  const databaseInputs: Array<Uint8Array | undefined> = [];
  const db = {
    run: vi.fn(),
  };
  const Database = vi.fn(function Database(data?: Uint8Array) {
    databaseInputs.push(data);
    return db;
  });
  const initSqlJs = vi.fn(async () => ({ Database }));

  return { Database, databaseInputs, db, initSqlJs };
});

vi.mock('sql.js', () => ({
  default: sqlState.initSqlJs,
}));

import { WebAdapter } from '../web';

interface FakeOpenRequest {
  result: IDBDatabase;
  error: Error | null;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeReadRequest {
  result: Uint8Array | undefined;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeReadTransaction {
  error: Error | null;
  objectStore: ReturnType<typeof vi.fn>;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');

function installIndexedDbOpen(open: () => IDBOpenDBRequest): ReturnType<typeof vi.fn> {
  const openMock = vi.fn(open);
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { open: openMock },
  });
  return openMock;
}

function installSuccessfulOpen(idb: IDBDatabase): ReturnType<typeof vi.fn> {
  return installIndexedDbOpen(() => {
    const request: FakeOpenRequest = {
      result: idb,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => request.onsuccess?.());
    return request as unknown as IDBOpenDBRequest;
  });
}

function createReadTransaction(options: {
  result?: Uint8Array;
  requestError?: Error;
  transactionError?: Error;
}): FakeReadTransaction {
  const request: FakeReadRequest = {
    result: options.result,
    error: options.requestError ?? null,
    onsuccess: null,
    onerror: null,
  };
  const transaction: FakeReadTransaction = {
    error: options.transactionError ?? null,
    objectStore: vi.fn(() => ({
      get: vi.fn(() => {
        queueMicrotask(() => {
          if (options.requestError) {
            request.onerror?.();
            return;
          }

          request.onsuccess?.();
          if (options.transactionError) {
            transaction.onabort?.();
          } else {
            transaction.oncomplete?.();
          }
        });
        return request as unknown as IDBRequest<Uint8Array | undefined>;
      }),
    })),
    oncomplete: null,
    onerror: null,
    onabort: null,
  };

  return transaction;
}

function createIdb(transaction: FakeReadTransaction): {
  idb: IDBDatabase;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const idb = {
    transaction: vi.fn(() => transaction),
    close,
  } as unknown as IDBDatabase;
  return { idb, close };
}

describe('WebAdapter.create IndexedDB loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlState.databaseInputs.length = 0;
  });

  afterEach(() => {
    if (originalIndexedDb) {
      Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });

  it('creates a new database only after a successful read finds no saved record', async () => {
    const transaction = createReadTransaction({});
    const { idb, close } = createIdb(transaction);
    installSuccessfulOpen(idb);

    await WebAdapter.create();

    expect(sqlState.databaseInputs).toEqual([undefined]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('restores the saved database after the read transaction completes', async () => {
    const saved = new Uint8Array([1, 2, 3]);
    const transaction = createReadTransaction({ result: saved });
    const { idb, close } = createIdb(transaction);
    installSuccessfulOpen(idb);

    await WebAdapter.create();

    expect(sqlState.databaseInputs).toEqual([saved]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates an IndexedDB open failure without constructing an empty database', async () => {
    const failure = new Error('IndexedDB open failed');
    installIndexedDbOpen(() => {
      const request: FakeOpenRequest = {
        result: undefined as unknown as IDBDatabase,
        error: failure,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    });

    await expect(WebAdapter.create()).rejects.toBe(failure);
    expect(sqlState.Database).not.toHaveBeenCalled();
  });

  it('propagates a transaction creation failure without constructing an empty database', async () => {
    const failure = new Error('IndexedDB transaction failed');
    const close = vi.fn();
    const idb = {
      transaction: vi.fn(() => {
        throw failure;
      }),
      close,
    } as unknown as IDBDatabase;
    installSuccessfulOpen(idb);

    await expect(WebAdapter.create()).rejects.toBe(failure);
    expect(sqlState.Database).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates a record read failure without constructing an empty database', async () => {
    const failure = new Error('IndexedDB record read failed');
    const transaction = createReadTransaction({ requestError: failure });
    const { idb, close } = createIdb(transaction);
    installSuccessfulOpen(idb);

    await expect(WebAdapter.create()).rejects.toBe(failure);
    expect(sqlState.Database).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('propagates an abort after a successful request instead of accepting partial success', async () => {
    const failure = new Error('IndexedDB read transaction aborted');
    const transaction = createReadTransaction({ transactionError: failure });
    const { idb, close } = createIdb(transaction);
    installSuccessfulOpen(idb);

    await expect(WebAdapter.create()).rejects.toBe(failure);
    expect(sqlState.Database).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

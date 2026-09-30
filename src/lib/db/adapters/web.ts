import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';

const IDB_NAME = 'hipago-sqlite';
const IDB_STORE = 'db';
const IDB_KEY = 'main';

/**
 * Browser SQLite adapter using sql.js (WASM).
 * Persists the database to IndexedDB so data survives page reloads.
 */
export class WebAdapter implements DbAdapter {
  private db: SqlJsDatabase;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadHandler: (() => void) | null = null;
  private transactionFinished: Promise<void> | null = null;
  private finishTransaction: (() => void) | null = null;
  private persistenceTurn: Promise<void> = Promise.resolve();
  private revision = 0;
  private closing = false;
  dirty = false;

  static async create(): Promise<WebAdapter> {
    const SQL = await initSqlJs({
      locateFile: () => '/sql-wasm-browser.wasm',
    });

    // Try to restore from IndexedDB
    const saved = await loadFromIndexedDB();
    const db = saved ? new SQL.Database(saved) : new SQL.Database();

    const adapter = new WebAdapter(db);
    db.run('PRAGMA foreign_keys = ON');

    // Flush pending writes before tab close to prevent data loss
    if (typeof window !== 'undefined') {
      const handler = () => {
        if (adapter.dirty) {
          // Best effort: IndexedDB is asynchronous, but exporting an active
          // sql.js transaction would roll it back even if the tab stays open.
          void adapter.persist().catch(() => {});
        }
      };
      window.addEventListener('beforeunload', handler);
      adapter.unloadHandler = handler;
    }

    return adapter;
  }

  private constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.assertWritable();
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = this.db.getRowsModified();
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowId = result.length > 0 ? (result[0].values[0][0] as number) : 0;
    this.scheduleSave();
    return { changes, lastInsertRowId };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  async exec(sql: string): Promise<void> {
    const command = sql.match(/^\s*(\w+)/)?.[1].toUpperCase();
    this.assertWritable();
    if (this.closing && command === 'BEGIN') throw new Error('Database is closing.');
    this.db.exec(sql);
    if (command === 'BEGIN') {
      this.transactionFinished = new Promise((resolve) => {
        this.finishTransaction = resolve;
      });
    } else if (
      command === 'COMMIT' ||
      command === 'END' ||
      (command === 'ROLLBACK' && !/^\s*ROLLBACK\s+(?:TRANSACTION\s+)?TO\b/i.test(sql))
    ) {
      const finish = this.finishTransaction;
      this.transactionFinished = null;
      this.finishTransaction = null;
      finish?.();
    }
    this.scheduleSave();
  }

  private assertWritable(): void {
    if (this.closing && !this.transactionFinished) throw new Error('Database is closing.');
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.persist();
      if (this.unloadHandler && typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', this.unloadHandler);
        this.unloadHandler = null;
      }
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.db.close();
    } catch (error) {
      this.closing = false;
      throw error;
    }
  }

  /** Debounced save — persists at most once per second. */
  private scheduleSave(): void {
    this.dirty = true;
    this.revision += 1;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.persist().catch((e) => console.warn('[db] Persist failed:', e));
      }
    }, 1000);
  }

  /** Save current DB state to IndexedDB. */
  async persist(): Promise<void> {
    // sql.js export closes/reopens SQLite: wait until the transaction owner
    // has committed or rolled back, including another owner starting meanwhile.
    while (this.transactionFinished) await this.transactionFinished;
    const revision = this.revision;
    const foreignKeys = this.db.exec('PRAGMA foreign_keys')[0]?.values[0][0];
    let data: Uint8Array;
    try {
      data = this.db.export();
    } finally {
      this.db.run(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
    // Capture the snapshot synchronously, then write snapshots in capture order.
    const turn = this.persistenceTurn.catch(() => {}).then(() => saveToIndexedDB(data));
    this.persistenceTurn = turn;
    try {
      await turn;
      if (this.revision === revision) this.dirty = false;
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}

// --- IndexedDB helpers ---

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
  try {
    const idb = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Recoverable: IndexedDB unavailable or blocked — fall back to fresh WASM init
    return null;
  }
}

async function saveToIndexedDB(data: Uint8Array): Promise<void> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

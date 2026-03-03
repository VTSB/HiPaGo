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
          const data = db.export();
          // Synchronous IDB write via blocking transaction isn't possible,
          // but navigator.sendBeacon doesn't help for IDB. Best-effort persist.
          try {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onsuccess = () => {
              const tx = req.result.transaction(IDB_STORE, 'readwrite');
              tx.objectStore(IDB_STORE).put(data, IDB_KEY);
            };
          } catch {
            // Recoverable: IndexedDB write during tab close — best effort persistence
          }
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
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params as any[]);
      stmt.step();
    } finally {
      stmt.free();
    }
    const changes = this.db.getRowsModified();
    const db = this.db;
    this.scheduleSave();
    return {
      changes,
      get lastInsertRowId() {
        const result = db.exec('SELECT last_insert_rowid() as id');
        return result.length > 0 ? (result[0].values[0][0] as number) : 0;
      },
    };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    this.scheduleSave();
  }

  async close(): Promise<void> {
    if (this.unloadHandler && typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
    this.db.close();
  }

  /** Debounced save — persists at most once per second. */
  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        this.dirty = false;
        this.persist().catch((e) => console.warn('[db] Persist failed:', e));
      }
    }, 1000);
  }

  /** Save current DB state to IndexedDB. */
  async persist(): Promise<void> {
    const data = this.db.export();
    await saveToIndexedDB(data);
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
  });
}

/**
 * Database adapter interface for platform-agnostic SQLite access.
 * Implementations: TauriAdapter (desktop), CapacitorAdapter (mobile), TestAdapter (tests).
 */

export interface QueryResult {
  changes: number;
  lastInsertRowId: number;
}

export interface DbAdapter {
  /**
   * Set false when BEGIN/COMMIT commands are not pinned to one connection.
   * The transaction helper still serializes the callback, but lets each
   * statement auto-commit instead of creating a broken cross-connection tx.
   */
  supportsExplicitTransactions?: boolean;

  /** Execute a parameterized write statement (INSERT/UPDATE/DELETE). */
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;

  /** Execute a parameterized read query (SELECT). Returns array of row objects. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute raw SQL (DDL, multi-statement). No parameters. */
  exec(sql: string): Promise<void>;

  /** Close the database connection. */
  close(): Promise<void>;

  /** Immediately persist the database (no-op on adapters that auto-commit). */
  persist?(): Promise<void>;
}

// --- Global database singleton ---

let _db: DbAdapter | null = null;
let _rawDb: DbAdapter | null = null;
let _ensureInit: (() => Promise<void>) | null = null;

// Native adapters expose transactions as separate BEGIN / statement / COMMIT
// calls. The Tauri SQL plugin also routes every command through a connection
// pool, so allowing even a plain query/write to interleave with that sequence
// can move the next transaction statement to another connection. Keep every
// public DB operation on one FIFO lane; withTransaction holds the lane for its
// complete sequence and uses the raw adapter while it owns the lock.
let _operationTail: Promise<void> = Promise.resolve();

async function acquireDatabaseLock(): Promise<() => void> {
  const previous = _operationTail;
  let release!: () => void;
  _operationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

async function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquireDatabaseLock();
  try {
    return await operation();
  } finally {
    release();
  }
}

function createSerializedAdapter(adapter: DbAdapter): DbAdapter {
  return {
    supportsExplicitTransactions: adapter.supportsExplicitTransactions,
    execute: (sql, params) => serializeOperation(() => adapter.execute(sql, params)),
    query: <T>(sql: string, params?: unknown[]) =>
      serializeOperation(() => adapter.query<T>(sql, params)),
    exec: (sql) => serializeOperation(() => adapter.exec(sql)),
    close: () => serializeOperation(() => adapter.close()),
    persist: adapter.persist ? () => serializeOperation(() => adapter.persist!()) : undefined,
  };
}

/** Register the database initializer (called once from schema.ts). */
export function setEnsureInit(fn: () => Promise<void>): void {
  _ensureInit = fn;
}

/** Get the DB adapter, ensuring initialization first. Use this in all production code. */
export async function ensureDb(): Promise<DbAdapter> {
  if (!_db && _ensureInit) await _ensureInit();
  if (!_db) throw new Error('Database not initialized.');
  return _db;
}

/** Get the DB adapter synchronously. Only for tests and internal use where DB is guaranteed ready. */
export function getDb(): DbAdapter {
  if (!_db) throw new Error('Database not initialized. Call setDb() first.');
  return _db;
}

export function setDb(adapter: DbAdapter): void {
  _rawDb = adapter;
  _db = createSerializedAdapter(adapter);
}

export function isDbInitialized(): boolean {
  return _db !== null;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
    _rawDb = null;
  }
}

/** Immediately persist the database to storage (for critical writes on web). No-op on adapters without persist(). */
export async function persistDb(): Promise<void> {
  if (_db?.persist) {
    await _db.persist();
  }
}

/** Execute multiple statements inside a transaction. */
export async function withTransaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
  await ensureDb();
  const release = await acquireDatabaseLock();
  try {
    const db = _rawDb;
    if (!db) throw new Error('Database not initialized.');
    if (db.supportsExplicitTransactions === false) {
      return await fn(db);
    }
    await db.exec('BEGIN');
    try {
      const result = await fn(db);
      await db.exec('COMMIT');
      return result;
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    release();
  }
}

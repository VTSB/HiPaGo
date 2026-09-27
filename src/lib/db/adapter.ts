/**
 * Database adapter interface for platform-agnostic SQLite access.
 * Implementations: TauriAdapter (desktop), CapacitorAdapter (mobile), TestAdapter (tests).
 */

export interface QueryResult {
  changes: number;
  lastInsertRowId: number;
}

export interface DbAdapter {
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
let _ensureInit: (() => Promise<void>) | null = null;

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
  _db = adapter;
}

export function isDbInitialized(): boolean {
  return _db !== null;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

/** Immediately persist the database to storage (for critical writes on web). No-op on adapters without persist(). */
export async function persistDb(): Promise<void> {
  if (_db?.persist) {
    await _db.persist();
  }
}

const transactionTurns = new WeakMap<DbAdapter, Promise<void>>();

/**
 * Execute multiple statements inside a transaction, serializing explicit
 * transactions on the same connection. Callbacks must not nest withTransaction.
 * Direct adapter operations still share the active transaction; callers needing
 * their own commit/rollback boundary must use this helper.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = await ensureDb();
  const previousTurn = transactionTurns.get(db) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  transactionTurns.set(db, turn);

  await previousTurn;
  try {
    await db.exec('BEGIN');
    try {
      const result = await fn();
      await db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await db.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('[db] Rollback failed:', rollbackError);
      }
      throw error;
    }
  } finally {
    releaseTurn();
    if (transactionTurns.get(db) === turn) transactionTurns.delete(db);
  }
}

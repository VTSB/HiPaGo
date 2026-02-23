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
}

// --- Global database singleton ---

let _db: DbAdapter | null = null;

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

/** Execute multiple statements inside a transaction. */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = getDb();
  await db.exec('BEGIN');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

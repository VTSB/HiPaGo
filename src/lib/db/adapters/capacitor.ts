import type { DbAdapter, QueryResult } from '../adapter';

/**
 * SQLite adapter for Capacitor mobile using @capacitor-community/sqlite.
 * Requires: `pnpm add @capacitor-community/sqlite` when Capacitor is set up.
 */
export class CapacitorAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  static async create(dbName: string = 'hipago'): Promise<CapacitorAdapter> {
    const { CapacitorSQLite, SQLiteConnection } = await import(
      '@capacitor-community/sqlite'
    );
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const db = await sqlite.createConnection(
      dbName,
      false,
      'no-encryption',
      1,
      false,
    );
    await db.open();
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA foreign_keys = ON');
    return new CapacitorAdapter(db);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(db: any) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = await this.db.run(sql, params);
    return {
      changes: result.changes?.changes ?? 0,
      lastInsertRowId: result.changes?.lastId ?? 0,
    };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query(sql, params);
    return (result.values ?? []) as T[];
  }

  async exec(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.db.execute(stmt);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

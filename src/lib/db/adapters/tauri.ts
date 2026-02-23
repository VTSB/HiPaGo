import type { DbAdapter, QueryResult } from '../adapter';

/**
 * SQLite adapter for Tauri desktop using @tauri-apps/plugin-sql.
 * Requires: `pnpm add @tauri-apps/plugin-sql` when Tauri is set up.
 */
export class TauriAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  static async create(path: string = 'sqlite:hipago.db'): Promise<TauriAdapter> {
    const { default: Database } = await import('@tauri-apps/plugin-sql');
    const db = await Database.load(path);
    await db.execute('PRAGMA journal_mode = WAL', []);
    await db.execute('PRAGMA foreign_keys = ON', []);
    return new TauriAdapter(db);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(db: any) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const result = await this.db.execute(sql, params);
    return {
      changes: result.rowsAffected ?? 0,
      lastInsertRowId: result.lastInsertId ?? 0,
    };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.select(sql, params) as Promise<T[]>;
  }

  async exec(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.db.execute(stmt, []);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

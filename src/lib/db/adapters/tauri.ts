import type { DbAdapter, QueryResult } from '../adapter';

export const TAURI_DB_PATH = 'sqlite:hipago.db';

/**
 * SQLite adapter for Tauri desktop using tauri-plugin-sql commands directly.
 *
 * Do not import @tauri-apps/plugin-sql here. In static-export/Tauri bundles the
 * JS guest binding can be rewritten through browser aliases or package interop,
 * which produced a Capacitor-shaped module at runtime
 * (`CapacitorSQLite, SQLiteConnection, default`) instead of Database.load.
 * The guest binding is only a tiny wrapper around these invoke commands, so
 * calling them directly is less fragile.
 */
export class TauriAdapter implements DbAdapter {
  private dbPath: string;

  static async create(path: string = TAURI_DB_PATH): Promise<TauriAdapter> {
    const { invoke } = await import('@tauri-apps/api/core');
    const dbPath = await invoke<string>('plugin:sql|load', { db: path });
    const adapter = new TauriAdapter(dbPath);
    await adapter.execute('PRAGMA journal_mode = WAL', []);
    await adapter.execute('PRAGMA foreign_keys = ON', []);
    return adapter;
  }

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const { invoke } = await import('@tauri-apps/api/core');
    const [rowsAffected, lastInsertId] = await invoke<[number, number]>('plugin:sql|execute', {
      db: this.dbPath,
      query: sql,
      values: params,
    });
    return {
      changes: rowsAffected ?? 0,
      lastInsertRowId: lastInsertId ?? 0,
    };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T[]>('plugin:sql|select', {
      db: this.dbPath,
      query: sql,
      values: params,
    });
  }

  async exec(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.execute(stmt, []);
    }
  }

  async close(): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('plugin:sql|close', { db: this.dbPath });
  }
}

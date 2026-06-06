import type { DbAdapter, QueryResult } from '../adapter';

type TauriSqlDatabaseConstructor = {
  load(path: string): Promise<unknown>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readExport(mod: any, key: string): unknown {
  try {
    return mod?.[key];
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveDatabaseConstructor(mod: any): TauriSqlDatabaseConstructor {
  const defaultExport = readExport(mod, 'default');
  const namedExport = readExport(mod, 'Database');
  const candidates = [
    defaultExport,
    namedExport,
    readExport(defaultExport, 'default'),
    readExport(defaultExport, 'Database'),
    mod,
  ];
  const Database = candidates.find((candidate) => typeof readExport(candidate, 'load') === 'function');
  if (!Database) {
    const keys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
    throw new Error(
      `@tauri-apps/plugin-sql Database.load export not found; module keys: [${keys.join(', ')}]`,
    );
  }
  return Database;
}

/**
 * SQLite adapter for Tauri desktop using @tauri-apps/plugin-sql.
 * Requires: `pnpm add @tauri-apps/plugin-sql` when Tauri is set up.
 */
export class TauriAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  static async create(path: string = 'sqlite:hipago.db'): Promise<TauriAdapter> {
    const Database = resolveDatabaseConstructor(await import('@tauri-apps/plugin-sql'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (await Database.load(path)) as any;
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

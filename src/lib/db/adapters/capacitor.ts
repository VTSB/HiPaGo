import type { DbAdapter, QueryResult } from '../adapter';
import type { SQLiteConnection as SQLiteConnectionInstance } from '@capacitor-community/sqlite';

/**
 * SQLite adapter for Capacitor mobile using @capacitor-community/sqlite.
 * Requires: `pnpm add @capacitor-community/sqlite` when Capacitor is set up.
 */
export class CapacitorAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  static async create(dbName: string = 'hipago'): Promise<CapacitorAdapter> {
    // Wrap every native step so any failure throws an Error whose message names
    // the exact step. Capacitor's native rejections are otherwise opaque on
    // device (no logcat), and DbErrorBanner surfaces this message verbatim.
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`capacitor: ${name} failed: ${msg}`);
      }
    };

    const mod = (await step('import plugin', () => import('@capacitor-community/sqlite'))) as {
      CapacitorSQLite?: unknown;
      SQLiteConnection?: unknown;
      default?: { CapacitorSQLite?: unknown; SQLiteConnection?: unknown };
    };

    // Resolve defensively. In the minified static-export bundle the named
    // exports can land under `.default` via CJS interop, which made the bare
    // `new SQLiteConnection(...)` throw the opaque "r is not a constructor".
    // Prefer the namespace binding, fall back to `.default`.
    const CapacitorSQLite = mod.CapacitorSQLite ?? mod.default?.CapacitorSQLite;
    let SQLiteConnectionCtor = mod.SQLiteConnection ?? mod.default?.SQLiteConnection;

    // The package's entry only exposes SQLiteConnection via `export * from
    // './definitions'`. The production minifier (Android static-export build)
    // can tree-shake that re-exported binding to undefined -> "r is not a
    // constructor". When that happens, import the class DIRECTLY from its
    // defining module, which has no re-export indirection for the tree-shaker
    // to mishandle, so the class survives.
    if (typeof SQLiteConnectionCtor !== 'function') {
      const defs = (await step(
        'import plugin definitions (fallback)',
        () => import('@capacitor-community/sqlite/dist/esm/definitions'),
      )) as { SQLiteConnection?: unknown; default?: { SQLiteConnection?: unknown } };
      SQLiteConnectionCtor = defs.SQLiteConnection ?? defs.default?.SQLiteConnection;
    }

    const sqlite = await step('construct SQLiteConnection', async () => {
      if (typeof SQLiteConnectionCtor !== 'function') {
        // Actionable message instead of "r is not a constructor": name what we
        // actually got so a device log points at the real bundling problem.
        throw new Error(
          `SQLiteConnection export is not a constructor (got ${typeof SQLiteConnectionCtor}); ` +
            `module keys: [${Object.keys(mod).join(', ')}]`,
        );
      }
      const Ctor = SQLiteConnectionCtor as new (plugin: unknown) => SQLiteConnectionInstance;
      return new Ctor(CapacitorSQLite);
    });

    // Acquire the connection resiliently. After an app reload the JS bridge may
    // still hold a connection of this name; a blind createConnection throws
    // "Connection <name> already exists" and the whole DB init fails
    // (history/favorites then silently break). Conversely, checkConnectionsConsistency
    // can mark a name as a connection while the JS handle is gone, so a blind
    // retrieveConnection can also fail. Try the likely path first, fall back to
    // the other.
    await sqlite.checkConnectionsConsistency().catch(() => undefined);
    const existing = await step(
      'isConnection',
      async () => (await sqlite.isConnection(dbName, false)).result,
    );

    const fresh = () =>
      sqlite.createConnection(dbName, false, 'no-encryption', 1, false);
    const reuse = () => sqlite.retrieveConnection(dbName, false);

    let db;
    if (existing) {
      try {
        db = await reuse();
      } catch {
        db = await step('createConnection (after retrieve failed)', fresh);
      }
    } else {
      try {
        db = await fresh();
      } catch {
        // Most likely "already exists" — a native connection without a JS handle.
        db = await step('retrieveConnection (after create failed)', reuse);
      }
    }

    await step('open', () => db.open());
    await step('PRAGMA journal_mode=WAL', () => db.execute('PRAGMA journal_mode = WAL'));
    await step('PRAGMA foreign_keys=ON', () => db.execute('PRAGMA foreign_keys = ON'));
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

import { registerPlugin } from '@capacitor/core';
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
    // CapacitorSQLite (the registerPlugin proxy) is also tree-shaken to undefined
    // in the minified bundle. Register it directly as a last resort: on native
    // this proxy binds to the native plugin, and `registerPlugin` is a used
    // import so it cannot be tree-shaken. Passing an undefined plugin to
    // `new SQLiteConnection(...)` is what caused
    // "createConnection failed: Cannot read properties of undefined".
    const CapacitorSQLite =
      mod.CapacitorSQLite ?? mod.default?.CapacitorSQLite ?? registerPlugin('CapacitorSQLite');
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
        db = await step('retrieveConnection', reuse);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only a missing/stale JS handle is recoverable by creating instead.
        // Any other retrieve failure is the real problem — surface it.
        if (/does not exist|not available|no available connection/i.test(msg)) {
          db = await step('createConnection (retrieve had no handle)', fresh);
        } else {
          throw e;
        }
      }
    } else {
      try {
        db = await step('createConnection', fresh);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only the "already exists" race (a native connection without a JS
        // handle) is recoverable by retrieving. Any other createConnection
        // failure is the real cause — surface it instead of masking it behind a
        // misleading "Connection <name> does not exist" from the retrieve path.
        if (/already exists/i.test(msg)) {
          db = await step('retrieveConnection (create reported already-exists)', reuse);
        } else {
          throw e;
        }
      }
    }

    await step('open', () => db.open());
    // journal_mode returns the resulting mode (a row), so it must go through
    // query() — the Android plugin's execute()/execSQL() rejects row-returning
    // statements ("Queries cannot be performed using execSQL(), use query()").
    // foreign_keys = ON is a setter (no rows), so execute() is fine.
    await step('PRAGMA journal_mode=WAL', () => db.query('PRAGMA journal_mode = WAL'));
    await step('PRAGMA foreign_keys=ON', () => db.execute('PRAGMA foreign_keys = ON'));
    return new CapacitorAdapter(db);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(db: any) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    // transaction=false: the plugin's run() defaults to wrapping each call in its
    // own BEGIN/COMMIT. Transactions are managed one level up (runMigrations,
    // withTransaction) with explicit BEGIN/COMMIT, so the implicit wrap would
    // nest and fail ("cannot start a transaction within a transaction").
    const result = await this.db.run(sql, params, false);
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
      // transaction=false — see execute() above. Lets the explicit BEGIN/COMMIT
      // issued by runMigrations actually open/close the transaction instead of
      // nesting inside the plugin's implicit one.
      await this.db.execute(stmt, false);
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

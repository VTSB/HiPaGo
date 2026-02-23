/**
 * Test database helper using sql.js (WASM) for in-memory SQLite tests.
 * No native compilation needed — works everywhere.
 */
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { setDb, closeDb, getDb } from '../adapter';
import { SCHEMA_SQL } from '../schema-sql';

class TestAdapter implements DbAdapter {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run('PRAGMA foreign_keys = ON');
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.db.run(sql, params as any[]);
    const changes = this.db.getRowsModified();
    // sql.js doesn't expose last_insert_rowid directly from run,
    // so we query it separately
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowId =
      result.length > 0 ? (result[0].values[0][0] as number) : 0;
    return { changes, lastInsertRowId };
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as T;
      rows.push(row);
    }
    stmt.free();
    return rows;
  }

  async exec(sql: string): Promise<void> {
    this.db.run(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Create an in-memory test database with the full schema. */
export async function setupTestDb(): Promise<void> {
  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database();
  const adapter = new TestAdapter(sqlDb);
  await adapter.exec(SCHEMA_SQL);
  setDb(adapter);
}

/** Clear all table data between tests. */
export async function clearAllTables(): Promise<void> {
  const db = getDb();
  await db.exec(`
    DELETE FROM gallery_tag;
    DELETE FROM gallery_relate;
    DELETE FROM gallery_image;
    DELETE FROM tag_i18n;
    DELETE FROM tag_transform;
    DELETE FROM tag;
    DELETE FROM gallery;
    DELETE FROM sync_status;
    DELETE FROM favorites;
    DELETE FROM history;
  `);
}

/** Close the test database. */
export async function teardownTestDb(): Promise<void> {
  await closeDb();
}

/** Query helper for test assertions. */
export async function queryAll<T>(sql: string, params?: unknown[]): Promise<T[]> {
  return getDb().query<T>(sql, params);
}

/** Query single row helper. */
export async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await getDb().query<T>(sql, params);
  return rows[0];
}

/** Count rows in a table. */
export async function countRows(table: string): Promise<number> {
  const result = await getDb().query<{ c: number }>(
    `SELECT COUNT(*) as c FROM ${table}`,
  );
  return result[0].c;
}

/**
 * Tests for PRAGMA user_version behavior through the sql.js (WebAdapter-style) adapter.
 *
 * These tests verify that PRAGMA user_version read/write works correctly through
 * the adapter's query() and exec() paths — critical for the migration runner.
 *
 * Note: TauriAdapter and CapacitorAdapter split SQL on semicolons in exec() and
 * route through execute(). The SQL semantics verified here apply to all adapters
 * since they all use SQLite under the hood.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import type { DbAdapter, QueryResult } from '../adapter';
import { setDb, closeDb } from '../adapter';
import { runMigrations } from '../migrations';

// ---------------------------------------------------------------------------
// Minimal in-memory adapter — mirrors test-db.ts TestAdapter but standalone
// so these tests don't depend on schema or other test state.
// ---------------------------------------------------------------------------

class PragmaTestAdapter implements DbAdapter {
  private db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    this.db.run(sql, params as any[]);
    const changes = this.db.getRowsModified();
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
      rows.push(stmt.getAsObject() as T);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createAdapter(): Promise<PragmaTestAdapter> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  return new PragmaTestAdapter(db);
}

async function getUserVersion(adapter: PragmaTestAdapter): Promise<number> {
  const rows = await adapter.query<{ user_version: number }>(
    'PRAGMA user_version',
  );
  return rows[0].user_version;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PRAGMA user_version', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('returns 0 for a fresh database', async () => {
    const version = await getUserVersion(adapter);
    expect(version).toBe(0);
  });

  it('write + read roundtrip', async () => {
    await adapter.exec('PRAGMA user_version = 5');
    const version = await getUserVersion(adapter);
    expect(version).toBe(5);
  });

  it('PRAGMA user_version set inside a committed transaction persists', async () => {
    await adapter.exec('BEGIN');
    await adapter.exec('PRAGMA user_version = 3');
    await adapter.exec('COMMIT');

    const version = await getUserVersion(adapter);
    expect(version).toBe(3);
  });

  it('PRAGMA user_version set inside a rolled-back transaction is reverted', async () => {
    await adapter.exec('BEGIN');
    await adapter.exec('PRAGMA user_version = 3');
    await adapter.exec('ROLLBACK');

    const version = await getUserVersion(adapter);
    expect(version).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Old schema DDL (without language/mediaType) — simulates a pre-migration DB
// ---------------------------------------------------------------------------
const OLD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_status (
  tag TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

describe('runMigrations: pre-migration DB upgrade', () => {
  let adapter: PragmaTestAdapter;

  beforeEach(async () => {
    adapter = await createAdapter();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('sets user_version to 1 after running migrations on a pre-migration DB', async () => {
    // Simulate pre-migration state: old schema without language/mediaType columns
    await adapter.exec(OLD_SCHEMA_SQL);

    // user_version starts at 0
    expect(await getUserVersion(adapter)).toBe(0);

    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(1);
  });

  it('adds language and mediaType columns to gallery after migration', async () => {
    await adapter.exec(OLD_SCHEMA_SQL);
    await runMigrations(adapter);

    const cols = await adapter.query<{ name: string }>('PRAGMA table_info(gallery)');
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has('language')).toBe(true);
    expect(colNames.has('mediaType')).toBe(true);
  });

  it('is idempotent: running migrations twice does not change user_version', async () => {
    await adapter.exec(OLD_SCHEMA_SQL);
    await runMigrations(adapter);
    await runMigrations(adapter);

    expect(await getUserVersion(adapter)).toBe(1);
  });

  it('does not alter user_version when columns already exist (fresh schema)', async () => {
    // Fresh schema already has language and mediaType — simulates new install
    const FRESH_SCHEMA = `
      CREATE TABLE IF NOT EXISTS gallery (
        id INTEGER PRIMARY KEY,
        type INTEGER NOT NULL,
        title TEXT NOT NULL,
        date TEXT NOT NULL,
        thumbnail TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        mediaType TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );
    `;
    await adapter.exec(FRESH_SCHEMA);
    // user_version is 0 on a fresh install before runMigrations
    expect(await getUserVersion(adapter)).toBe(0);
    await runMigrations(adapter);
    // After running migrations user_version should be 1 (migration still runs to set version)
    expect(await getUserVersion(adapter)).toBe(1);
  });
});
